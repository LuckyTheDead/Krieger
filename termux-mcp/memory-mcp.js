/**
 * termux-memory: append-only persistent memory store.
 *
 * Storage model
 * -------------
 * The file is an append-only log of operations, one JSON object per line:
 *
 *   {"v":1,"op":"put","id":"...","mem":{...}}    create or revise a memory
 *   {"v":1,"op":"forget","id":"...","at":"..."}   tombstone a memory
 *
 * Every write is a single appendFile of one complete line. There is no
 * read-modify-write of the whole file, so concurrent writers cannot clobber
 * each other. Loading folds the log: for a given id the latest op wins, and a
 * forget removes it.
 *
 * Recovery model
 * --------------
 * The only damage an append-only log can suffer is a torn final line from an
 * interrupted write. loadLog() detects that case explicitly and reports it.
 * appendOp() will not append onto an unterminated line; it seals the tail with
 * a newline first, so a torn record becomes its own (reported, skipped) line
 * rather than being glued onto the head of the next record.
 *
 * Bare records from the pre-append-only format (no `op` wrapper) are still
 * read as `put` so an existing store keeps working.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, appendFile, open, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SCHEMA_VERSION = 1;

const MEMORY_DIR = process.env.MEMORY_DIR
  || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "memory");
// Derived from this file's own location, NOT from $HOME. $HOME is the user's
// profile on Windows, so `~/tiny-agent/memory` resolved to
// C:\Users\<you>\tiny-agent\memory -- a path that does not exist -- and
// loadLog() silently returned zero memories instead of erroring. The store is
// a sibling of termux-mcp/ in the repo, so the repo is the reliable anchor.
const MEMORY_FILE = path.join(MEMORY_DIR, "memories.jsonl");

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Read and fold the log.
 *
 * Returns { memories, torn, corrupt, warnings }.
 *   memories  folded live memories, in first-seen order
 *   torn      true if the file ends mid-line (interrupted write)
 *   corrupt   [{ line, preview }] for unparseable lines that were NOT the
 *             torn tail -- real corruption, surfaced rather than hidden
 */
export async function loadLog(file = MEMORY_FILE) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { memories: [], torn: false, corrupt: [], warnings: [] };
    }
    throw err;
  }

  if (raw === "") {
    return { memories: [], torn: false, corrupt: [], warnings: [] };
  }

  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (endsWithNewline) lines.pop();

  const corrupt = [];
  const entries = [];
  let torn = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      const isTail = i === lines.length - 1 && !endsWithNewline;
      if (isTail) {
        torn = true;
      } else {
        corrupt.push({ line: i + 1, preview: line.slice(0, 120) });
      }
      continue;
    }
    entries.push(rec);
  }

  const memories = foldLog(entries);

  const warnings = [];
  if (torn) {
    warnings.push(
      "The log ends mid-record, which means a previous write was interrupted. " +
      "That partial record is unrecoverable and has been excluded. All complete " +
      "records are intact and searchable. The tail will be sealed on the next write."
    );
  }
  if (corrupt.length) {
    warnings.push(
      `${corrupt.length} unparseable line(s) in the log were skipped and excluded ` +
      `from search: ${corrupt.map(c => `line ${c.line} (${c.preview.length > 40 ? c.preview.slice(0, 40) + "..." : c.preview})`).join("; ")}`
    );
  }

  return { memories, torn, corrupt, warnings };
}

/** Fold an ordered entry list into live memories. Later ops for an id win. */
export function foldLog(entries) {
  const byId = new Map();
  const order = [];

  for (const rec of entries) {
    if (!rec || typeof rec !== "object") continue;

    // Legacy bare record: treat as a put.
    const op = rec.op || (rec.id && rec.content ? "put" : null);
    if (!op) continue;

    if (op === "put") {
      const mem = rec.mem || (rec.op ? null : rec);
      if (!mem || !mem.id) continue;
      if (!byId.has(mem.id)) order.push(mem.id);
      byId.set(mem.id, mem);
    } else if (op === "forget") {
      byId.delete(rec.id);
      const idx = order.indexOf(rec.id);
      if (idx !== -1) order.splice(idx, 1);
    }
  }

  return order.map(id => byId.get(id)).filter(Boolean);
}

export async function loadMemories(file = MEMORY_FILE) {
  const { memories } = await loadLog(file);
  return memories;
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/** True if the file exists, is non-empty, and does not end in a newline. */
async function hasUnterminatedTail(file) {
  let fh;
  try {
    fh = await open(file, "r");
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (st.size === 0) return false;
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(1), 0, 1, st.size - 1);
    return bytesRead === 1 && buffer[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}

/**
 * Append one operation. Seals an unterminated tail first so the new record
 * can never be concatenated onto a partial one.
 *
 * Returns { sealedTail } -- true if a torn tail was sealed by this call.
 */
export async function appendOp(op, file = MEMORY_FILE) {
  await mkdir(path.dirname(file), { recursive: true });

  const sealedTail = await hasUnterminatedTail(file);
  if (sealedTail) {
    await appendFile(file, "\n");
  }

  const line = JSON.stringify({ v: SCHEMA_VERSION, ...op }) + "\n";
  await appendFile(file, line);

  return { sealedTail };
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
  "how", "its", "new", "now", "old", "see", "two", "who", "did", "yes",
  "this", "that", "with", "from", "they", "have", "been", "were", "will",
  "would", "there", "their", "what", "about", "which", "when", "your",
  "into", "than", "then", "them", "these", "some", "such", "only", "other",
  "also", "just", "over", "very", "does", "doing", "done", "each", "more",
  "most", "much", "must", "should", "because", "while", "where", "after"
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

/** Lowercase and strip combining marks so accents fold to base letters. */
export function normalize(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * Conservative English suffix stripping, with double-consonant undoubling.
 *
 * Order matters: -ing/-ed are tried before the bare -s rule so that "deploys"
 * strips to "deploy" rather than having its trailing "s" removed first and
 * never being seen as -ing/-ed at all.
 *
 * "running" -> "runn" -> "run" happens in matchKey, not here. Returning the
 * raw "runn" is deliberate: matchKey is the only place that decides how much of
 * a token survives, and it can see the original length.
 */
export function stem(word) {
  if (word.length <= 3) return word;
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word) && word.length > 3) {
    return word.slice(0, -1);
  }
  return word;
}

/** "runn" -> "run", "stopp" -> "stop". Only when the stem stays 3+ chars. */
function undouble(w) {
  const n = w.length;
  if (n < 4) return w;
  const a = w[n - 1];
  const b = w[n - 2];
  if (a !== b) return w;
  if (!"bcdfgklmnprstz".includes(a)) return w;   // "ll"/"ss"/"ff"/"zz" are real
  return w.slice(0, -1);
}

/**
 * Match key for a token.
 *
 * Terms of 6+ characters are keyed on their first 5 characters. This collapses
 * morphological families that suffix stripping cannot reach without a real
 * stemmer -- "deploy", "deploying", "deployment", "deployments" all key to
 * "deplo" -- while leaving short words on exact match, so "mode" still cannot
 * match "manual".
 *
 * The stems produced by -ing/-ed stripping ("runn" from "running") are
 * undoubled first. "runn" is only 4 characters, so a length check placed ahead
 * of the undoubling would return it untouched and the fix would never run.
 * Undoubling first is also what makes it work: "runn" -> "run", so a query for
 * "running" finally shares a key with "run" and "runs". Previously the whole
 * family was unreachable and "running" matched nothing at all.
 *
 * The cost is occasional false positives between unrelated long words sharing a
 * 5-character prefix ("resist"/"resident"). For a memory store that is a
 * tolerable ranking error; silently returning memories that match nothing is not.
 */
export function matchKey(term) {
  const base = undouble(term);
  return base.length >= 6 ? base.slice(0, 5) : base;
}

/** Tokenize into searchable terms, stemmed and keyed for matching. */
export function tokenize(text) {
  const norm = normalize(text);
  const out = [];

  for (const run of norm.split(/[^\p{L}\p{N}]+/u)) {
    if (!run) continue;

    if (CJK_RE.test(run)) {
      for (let i = 0; i < run.length; i++) {
        out.push(run[i]);
        if (i + 1 < run.length) out.push(run[i] + run[i + 1]);
      }
    } else {
      out.push(matchKey(stem(run)));
    }
  }

  return out;
}

/** Token list with stopwords removed, unless that empties it. */
function contentTerms(text) {
  const toks = tokenize(text);
  const kept = toks.filter(t => !STOPWORDS.has(t));
  return kept.length ? kept : toks;
}

// ---------------------------------------------------------------------------
// Deduplication (near-duplicate detection)
//
// The check exists to stop the same fact being written twice. It must not
// refuse a *correction*: silently dropping a refinement leaves the stale
// version as the only truth in the store, which is worse than having two
// similar memories. So the veto fires only on a true duplicate, and any
// negation in the incoming text disables it outright -- the safe failure is to
// store a near-duplicate, not to discard a contradiction.
// ---------------------------------------------------------------------------

// Modifiers and clause words carry no identity on their own. Counting them
// inflated similarity: "A and B" vs "A, and also B" was a 0.8 overlap on
// function words alone, which is how an added carve-out got mistaken for a
// restatement.
//
// RETIRED as of the dedup rewrite below. Stopword filtering is gone from
// dedupWords because it made similarity length-sensitive in the wrong
// direction: "The user deploys on Fridays." has almost no content words left,
// so a near-identical second copy scored below the duplicate threshold and both
// were stored. The carve-out case above is now caught by the containment rule
// instead, which does not care about function words. Left here rather than
// deleted so the reasoning is not lost with it -- it is not exported and
// nothing reads it.
const DEDUP_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "her", "was", "one", "our", "out", "day", "get", "has", "him", "his",
  "how", "its", "new", "now", "old", "see", "two", "who", "did", "yes",
  "this", "that", "with", "from", "they", "have", "been", "were", "will",
  "would", "there", "their", "what", "about", "which", "when", "your",
  "into", "than", "then", "them", "these", "some", "such", "only", "other",
  "also", "just", "over", "very", "does", "doing", "done", "each", "more",
  "most", "much", "must", "should", "because", "while", "where", "after",
  "except", "unless", "until", "without", "instead", "however", "rather",
  "still", "even", "never", "always", "both", "either", "neither", "per",
  "via", "upon", "within", "across", "since", "whether"
]);

/**
 * True if the text contains a negation or a change-of-state marker.
 *
 * Deliberately blunt: a false positive only costs us the dedup check, whereas a
 * false negative silently discards a correction. Prefer storing a near
 * duplicate over dropping a contradiction.
 */
export function hasNegation(text) {
  return /\b(?:not|never|no|non|without|isnt|arent|doesnt|dont|cannot|won|shouldnt|wouldnt|cant|aint|no longer|instead of|rather than|stopped|quit|reverted|changed|updated|no longer|used to|formerly|actually|but|however|except|unless|whereas|incorrect|wrong|superseded|obsolete|deprecated)\b/
    .test(normalize(String(text)));
}

/**
 * Deduplication key words.
 *
 * Two problems with the obvious implementation, both found by execution:
 *
 * 1. `[a-z0-9]` flattening throws away every non-ASCII character, so a memory
 *    written in Chinese or Japanese became an empty word set, and similarity
 *    returned 0 against everything. A byte-identical re-store of Chinese text
 *    was therefore accepted as brand new. This now keeps every letter and
 *    digit in any script, and only drops punctuation and whitespace.
 *
 * 2. Words shorter than 4 characters were dropped, so short memories fell
 *    below the duplicate threshold purely because of their length. "The user
 *    deploys on Fridays." gained a second clause and gained a second copy in
 *    the store. The floor is now 2, so "UI", "CI" and "ok" still count.
 *
 * CJK runs are indexed as unigrams + bigrams, the same scheme the tokenizer
 * uses, so dedup and search agree on what a word is.
 */
function dedupWords(text) {
  const words = new Set();
  const norm = normalize(text);

  for (const run of norm.split(/[^\p{L}\p{N}]+/u)) {
    if (!run) continue;

    if (CJK_RE.test(run)) {
      for (let i = 0; i < run.length; i++) {
        words.add(run[i]);
        if (i + 1 < run.length) words.add(run[i] + run[i + 1]);
      }
    } else {
      if (run.length >= 2) words.add(run);
    }
  }

  return words;
}

function similarity(a, b) {
  const A = dedupWords(a);
  const B = dedupWords(b);

  if (!A.size || !B.size) return 0;

  let intersection = 0;
  for (const word of A) {
    if (B.has(word)) intersection++;
  }

  const union = new Set([...A, ...B]).size;
  return intersection / union;
}

/**
 * How much of the smaller memory's vocabulary is covered by the larger one.
 *
 * Jaccard punishes length differences, so a memory and the same memory plus
 * one extra clause score 0.68 and both get stored. Containment asks the
 * question that actually matters here: is everything the short one said still
 * said by the long one? Containment is measured in the larger direction, so
 * a fully-contained memory scores 1.0 and is caught whichever of the two is
 * newer.
 */
function containment(a, b) {
  const A = dedupWords(a);
  const B = dedupWords(b);

  if (!A.size || !B.size) return 0;

  const [small, large] = A.size <= B.size ? [A, B] : [B, A];

  let shared = 0;
  for (const word of small) {
    if (large.has(word)) shared++;
  }

  return shared / small.size;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Rank memories against a query.
 *
 * A memory is a candidate only if it shares at least one content term with the
 * query. Importance and confidence are tie-breakers only -- they can never
 * promote a memory that does not match. Previously the gate was `score > 0`
 * against a formula whose importance/confidence terms are always positive, so
 * every memory scored above zero and non-matching queries returned results.
 */
export function searchMemories(memories, query, limit) {
  const qTerms = [...new Set(contentTerms(query))];
  if (!qTerms.length || !memories.length) return [];

  // Document frequency for IDF.
  const docTerms = memories.map(mem => {
    const tf = new Map();
    for (const t of contentTerms(mem.content || "")) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }
    for (const tag of mem.tags || []) {
      for (const t of contentTerms(String(tag))) {
        // Tags are deliberate signal, so they count double.
        tf.set(t, (tf.get(t) || 0) + 2);
      }
    }
    return tf;
  });

  const N = memories.length;
  const idf = new Map();
  for (const t of qTerms) {
    let df = 0;
    for (const tf of docTerms) if (tf.has(t)) df++;
    idf.set(t, Math.log(1 + N / Math.max(df, 1)));
  }
  const idfTotal = [...idf.values()].reduce((a, b) => a + b, 0) || 1;

  const results = [];
  for (let i = 0; i < memories.length; i++) {
    const tf = docTerms[i];
    if (!tf) continue;

    let weighted = 0;
    let matched = 0;
    for (const t of qTerms) {
      const count = tf.get(t);
      if (!count) continue;
      matched++;
      weighted += Math.min(count, 3) * idf.get(t);
    }

    // Hard gate: at least one query term must actually be present.
    if (matched === 0) continue;

    const keywordScore = Math.min(1, weighted / idfTotal);
    const importance = Number(memories[i].importance ?? 0);
    const confidence = Number(memories[i].confidence ?? 0);

    const score =
      keywordScore * 0.85 +
      importance * 0.10 +
      confidence * 0.05;

    results.push({
      memory: memories[i],
      score,
      matchedTerms: matched,
      queryTerms: qTerms.length,
      keywordScore: Number(keywordScore.toFixed(3))
    });
  }

  return results
    .sort((a, b) =>
      b.score - a.score ||
      b.memory.importance - a.memory.importance ||
      (a.memory.id < b.memory.id ? -1 : 1))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

const ok = text => ({ content: [{ type: "text", text }] });
const TYPES = ["fact", "preference", "goal", "event", "context", "project"];

function warnPrefix(warnings) {
  if (!warnings || !warnings.length) return "";
  return warnings.map(w => `WARNING: ${w}`).join("\n") + "\n\n";
}

export function createHandlers({ file = MEMORY_FILE } = {}) {
  return {
    memory_store: async ({ content, type, importance, confidence, tags }) => {
      const { memories, warnings } = await loadLog(file);

      const candidates = memories
        .map(m => ({ memory: m, similarity: similarity(content, m.content) }))
        .sort((a, b) => b.similarity - a.similarity);

      // A correction is never a duplicate, whatever the token overlap says.
      //
      // Candidate set is NOT filtered by type. A fact and a preference with
      // identical wording are the same claim recorded twice under two labels,
      // and the veto has to see it. A per-type comparison previously let the
      // same sentence through as both a fact and a preference.
      //
      // The comparison is bidirectional: containment also counts. Jaccard alone
      // penalises length differences, so a memory and the same memory plus one
      // clause scored 0.68 and were both stored. Containment compares only the
      // shared vocabulary with itself, and every full containment is also a
      // full containment in reverse, so symmetric Jaccard is the wrong tool
      // here and the asymmetry cannot come back.
      const best = candidates.find(x => x.similarity >= 0.8) || candidates[0];
      const likelyRefinement = !!best && similarity(content, best.memory.content) >= 0.5;
      const duplicate = hasNegation(content)
        ? undefined
        : candidates.find(x =>
            x.similarity >= 0.8 || containment(content, x.memory.content) >= 0.9);

      if (duplicate) {
        return ok(
          warnPrefix(warnings) +
          `A highly similar memory already exists. No duplicate created.\n` +
          `ID: ${duplicate.memory.id}\n` +
          `Similarity: ${duplicate.similarity.toFixed(2)}\n` +
          `Existing memory: ${duplicate.memory.content}\n` +
          (likelyRefinement
            ? `\nIf this is a correction or a refinement rather than a duplicate, ` +
              `call memory_update on that ID instead of memory_store.`
            : "")
        );
      }

      const now = new Date().toISOString();
      const memory = {
        v: SCHEMA_VERSION,
        id: randomUUID(),
        content,
        type,
        importance,
        confidence,
        tags,
        created_at: now,
        updated_at: now
      };

      const { sealedTail } = await appendOp({ op: "put", id: memory.id, mem: memory }, file);

      return ok(
        (sealedTail
          ? "NOTE: sealed a truncated record from an interrupted write; it is excluded.\n\n"
          : "") +
        warnPrefix(warnings) +
        `Memory stored successfully.\nID: ${memory.id}`
      );
    },

    memory_search: async ({ query, limit }) => {
      const { memories, warnings } = await loadLog(file);

      if (!memories.length) {
        return ok(warnPrefix(warnings) + "No memories stored yet.");
      }

      const results = searchMemories(memories, query, limit);

      if (!results.length) {
        return ok(warnPrefix(warnings) + "No matching memories found.");
      }

      return ok(
        warnPrefix(warnings) +
        JSON.stringify(
          results.map(x => ({
            ...x.memory,
            relevance: Number(x.score.toFixed(3)),
            matchedTerms: x.matchedTerms,
            queryTerms: x.queryTerms,
            keywordScore: x.keywordScore
          })),
          null,
          2
        )
      );
    },

    memory_get: async ({ id }) => {
      const { memories, warnings } = await loadLog(file);
      const memory = memories.find(m => m.id === id);

      return ok(
        warnPrefix(warnings) +
        (memory ? JSON.stringify(memory, null, 2) : `Memory not found: ${id}`)
      );
    },

    memory_update: async ({ id, content, type, importance, confidence, tags }) => {
      const { memories, warnings } = await loadLog(file);
      const existing = memories.find(m => m.id === id);

      if (!existing) {
        return ok(warnPrefix(warnings) + `Memory not found: ${id}`);
      }

      // Revision is an append, not an in-place edit.
      const memory = { ...existing };
      if (content !== undefined) memory.content = content;
      if (type !== undefined) memory.type = type;
      if (importance !== undefined) memory.importance = importance;
      if (confidence !== undefined) memory.confidence = confidence;
      if (tags !== undefined) memory.tags = tags;
      memory.updated_at = new Date().toISOString();

      const { sealedTail } = await appendOp({ op: "put", id: memory.id, mem: memory }, file);

      return ok(
        (sealedTail
          ? "NOTE: sealed a truncated record from an interrupted write; it is excluded.\n\n"
          : "") +
        warnPrefix(warnings) +
        `Memory updated successfully.\n${JSON.stringify(memory, null, 2)}`
      );
    },

    memory_forget: async ({ id }) => {
      const { memories, warnings } = await loadLog(file);
      const existing = memories.find(m => m.id === id);

      if (!existing) {
        return ok(warnPrefix(warnings) + `Memory not found: ${id}`);
      }

      // Tombstone, not a rewrite. No live memory is ever mutated or removed
      // from the file, so concurrent forgets cannot corrupt each other.
      const { sealedTail } = await appendOp(
        { op: "forget", id, at: new Date().toISOString() },
        file
      );

      return ok(
        (sealedTail
          ? "NOTE: sealed a truncated record from an interrupted write; it is excluded.\n\n"
          : "") +
        warnPrefix(warnings) +
        `Memory forgotten successfully.\nID: ${id}\nContent: ${existing.content}`
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

export function buildServer() {
  const h = createHandlers();

  const server = new McpServer({ name: "termux-memory", version: "0.3.0" });

  server.tool(
    "memory_store",
    "Store persistent information. Refuses a near-exact duplicate, but a correction or refinement that negates the existing memory is always stored. If the existing memory should change rather than coexist, use memory_update instead.",
    {
      content: z.string().min(1),
      type: z.enum(TYPES).default("fact"),
      importance: z.number().min(0).max(1).default(0.5),
      confidence: z.number().min(0).max(1).default(1.0),
      tags: z.array(z.string()).default([])
    },
    h.memory_store
  );

  server.tool(
    "memory_search",
    "Search persistent memories by keywords and rank results by relevance, importance, and confidence. Returns only memories that actually match the query. `relevance` is a ranking score, not a match confidence: it stays high even when a memory matches only a small part of the query. Read `matchedTerms` against `queryTerms` to judge how well something actually matched.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10)
    },
    h.memory_search
  );

  server.tool(
    "memory_get",
    "Retrieve one specific memory by ID.",
    { id: z.string().min(1) },
    h.memory_get
  );

  server.tool(
    "memory_update",
    "Update an existing memory by ID. Recorded as an append-only revision.",
    {
      id: z.string().min(1),
      content: z.string().min(1).optional(),
      type: z.enum(TYPES).optional(),
      importance: z.number().min(0).max(1).optional(),
      confidence: z.number().min(0).max(1).optional(),
      tags: z.array(z.string()).optional()
    },
    h.memory_update
  );

  server.tool(
    "memory_forget",
    "Permanently delete a specific memory by ID. Writes a tombstone; the memory is no longer returned by search or get.",
    { id: z.string().min(1) },
    h.memory_forget
  );

  return server;
}

// Only start listening when run as a server, not when imported by tests.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await mkdir(MEMORY_DIR, { recursive: true });
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
