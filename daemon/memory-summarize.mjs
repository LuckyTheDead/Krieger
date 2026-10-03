#!/usr/bin/env node
// Summarize groups of related memories into one condensed memory.
//
//   node daemon/memory-summarize.mjs                 # report only, changes nothing
//   node daemon/memory-summarize.mjs --dry-run       # same, explicitly
//   node daemon/memory-summarize.mjs --apply         # write the summaries
//   node daemon/memory-summarize.mjs --threshold 40  # looser grouping
//   node daemon/memory-summarize.mjs --min-group 3   # only condense 3+ memories
//
// WHY THIS EXISTS
//
// The store is append-only and grows by accretion. Every fix, audit, and setup
// adds another long memory. On 2026-10-01 it held 35 records / 23 live, and a
// similarity scan found 11 overlapping pairs -- several genuinely redundant
// (two memories both describing the ARC prize state, one of which is partly
// superseded). Long memories also crowd the recall budget: recallContext trims
// to 3000 chars, so a verbose memory can crowd out a sharper one.
//
// WHY THIS IS NOT AUTOMATIC BY DEFAULT
//
// A summary is lossy, and the failure mode is bad in a specific way: a lossy
// summary of a CORRECT memory can be WRONG, and the wrong version is easier to
// trust than the verbose original. Worse, if a summary is fed back in as input
// to the next summarization, errors compound silently.
//
// Therefore, by default this only REPORTS. --apply is required to write. And it
// never tombstones a source memory: sources stay live and searchable forever.
// If a summary turns out wrong, delete the summary and the originals are intact.
// That is the whole reason the store is append-only, and this tool is built to
// take advantage of it rather than work against it.
//
// WHAT IT GUARDS AGAINST
//
//   - Summarizing a single memory (pointless; needs --min-group).
//   - Summarizing across unrelated topics (threshold on token overlap).
//   - Summarizing a memory that was itself a summary (prevents compounding).
//   - Losing the source of a claim (every summary lists what it absorbed).
//   - Summarizing a stale revision (readLive mirrors foldLog exactly).
//
// KNOWN LIMIT -- grouping is lexical, not semantic. On the first real run it
// merged three memories that share vocabulary but are three different topics
// (session_brief, the agent job kind, and the shebang fix) into one summary
// that is worse than any of them. Token overlap cannot tell "same subject" from
// "same repo". Tighten with --threshold if a group looks wrong, and treat every
// --apply as needing a read-back.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Overridable so the test suite can point at a temp store without touching the
// real one. Reads only; the write path always uses this same resolved file.
const MEMORY_FILE =
  process.env.KRIEGER_MEMORY_FILE || path.join(REPO_DIR, "memory", "memories.jsonl");

const DEFAULTS = { threshold: 35, minGroup: 2, apply: false };

// Same stopword set the memory MCP uses, so grouping agrees with search.
const STOPWORDS = new Set(
  ("the and for are but not you all any can her was one our out day get has him his " +
   "how its new now old see two who did yes this that with from they have been were " +
   "will would there their what about which when your into than then them these some " +
   "such only other also just over very does doing done each more most much must " +
   "should because while where after")
    .split(/\s+/)
);

// Markers that identify a memory as itself a summary. If any input is already a
// summary, the whole group is skipped: compressing a compression is how a
// detail quietly becomes wrong.
const SUMMARY_MARKERS = [
  "[summary of",
  "condensed from",
  "absorbed memories",
  "supersedes and condenses"
];

function tokens(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  // Jaccard against the SMALLER set: a 400-word memory that shares every topic
  // with a 60-word one is a superset, not a duplicate, and should group with it.
  return shared / Math.min(a.size, b.size);
}

function isSummary(m) {
  const c = String(m.content ?? "").toLowerCase();
  return SUMMARY_MARKERS.some((marker) => c.includes(marker)) || (m.tags ?? []).includes("summary");
}

// Union-find grouping: transitive overlap means A~B and B~C puts all three in
// one group, which is what a human would do when asked "are these the same
// topic?".
function groupBySimilarity(memories, threshold) {
  const parent = memories.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  const tok = memories.map((m) => tokens(m.content));
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      if (overlap(tok[i], tok[j]) * 100 >= threshold) union(i, j);
    }
  }

  const groups = new Map();
  memories.forEach((m, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(m);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

// Pick the terms that actually define the topic: frequent across the group and
// present in MOST members, with shared vocabulary weighted above raw frequency.
//
// 2026 and "agent" appear in nearly every memory in this store and identify
// nothing -- the first version's topic lines read "2026, agent, architecture".
// Two filters: drop terms that are mostly digits (dates, counts), and drop any
// term whose document frequency is >= 90% of the group, because a word in every
// member is a property of the corpus, not of the topic.
function topicTerms(members, limit = 6) {
  const docFreq = new Map();
  for (const m of members) {
    for (const t of tokens(m.content)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const ceiling = Math.ceil(members.length * 0.9);
  return [...docFreq.entries()]
    .filter(([term, n]) => n >= Math.max(2, Math.ceil(members.length * 0.5)))
    .filter(([term, n]) => n < ceiling || members.length <= 2)
    .filter(([term]) => !/^\d+$/.test(term) && !/^(19|20)\d{2}$/.test(term))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

// A summary that keeps the highest-value sentences from its sources.
//
// The first implementation split on /[^.!?]+[.!?]+/ which shredded file paths:
// "The system prompt is a markdown file (PROMPT.md) rather than something
// assembled in code." became "...(PROMPT." + "mjs (added..." -- mangled beyond
// use, and it broke the first summary of all three groups. The splitter below
// protects the two patterns that actually appear in this corpus:
//
//   - a sentence-ending . ? ! followed by whitespace and a capital/quote/backtick
//   - an abbreviation or an ellipsis: e.g. e.g.  i.e.  etc.  vs.  ...
//
// A path like daemon/lib/agent.mjs has no whitespace after its dot, so it never
// matches the terminator and survives intact.
function splitSentences(text) {
  const out = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buf += ch;
    if (ch !== "." && ch !== "?" && ch !== "!") continue;

    // Ellipsis: consume all of it and never treat it as a terminator.
    if (text.slice(i, i + 3) === "...") {
      buf += text.slice(i + 1, i + 3);
      i += 2;
      continue;
    }
    // An abbreviation immediately before the dot means it is not the end.
    const before = buf.slice(0, -1);
    if (/\b(e\.g|i\.e|etc|vs|resp|cf|approx|no|fig|al)\.$/i.test(before)) continue;

    const next = text[i + 1];
    if (next === undefined) break;
    if (!/\s/.test(next)) continue; // a path, a version, an initial
    if (!/[A-Z"'\`(]/.test(text[i + 2] ?? "")) continue; // lowercase continues the sentence

    out.push(buf.trim());
    buf = "";
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.length >= 25);
}

function condense(members, maxChars = 900) {
  const sentences = [];
  for (const m of members) {
    for (const raw of splitSentences(String(m.content ?? ""))) {
      const s = raw.replace(/\s+/g, " ").trim();
      if (s.length >= 25) sentences.push({ text: s, imp: m.importance ?? 0.5 });
    }
  }

  const terms = topicTerms(members);
  const scored = sentences
    .map((s) => {
      const st = tokens(s.text);
      let score = s.imp;
      for (const t of terms) if (st.has(t)) score += 0.25;
      // Prefer specificity: a sentence with digits or a file path is usually the
      // one carrying the actionable detail.
      if (/\d|[\/.]/.test(s.text)) score += 0.15;
      // Penalise sentences that read as meta-commentary about the memory itself.
      if (/^\s*(this (memory|note)|as of|updated)/i.test(s.text)) score -= 0.3;
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let used = 0;
  for (const s of scored) {
    // Skip a sentence already substantially covered by one already picked.
    const st = tokens(s.text);
    if (picked.some((p) => {
      const pt = tokens(p.text);
      let inter = 0;
      for (const w of pt) if (st.has(w)) inter++;
      return inter / Math.min(pt.size, st.size || 1) > 0.6;
    })) continue;
    if (used + s.text.length > maxChars && picked.length) continue;
    picked.push(s);
    used += s.text.length;
    if (used > maxChars) break;
  }
  return picked.map((s) => s.text);
}

function buildSummaryText(members, digest) {
  const ids = members.map((m) => String(m.id).slice(0, 8)).join(", ");
  const terms = topicTerms(members).join(", ");
  const dates = members
    .map((m) => String(m.updated_at ?? m.created_at ?? "").slice(0, 10))
    .filter(Boolean)
    .sort();
  const span = dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0] ?? "";

  return (
    `[SUMMARY OF ${members.length} MEMORIES — ${ids}]\n` +
    `Topic (shared vocabulary): ${terms}\n` +
    (span ? `Source dates: ${span}\n` : "") +
    `\n` +
    digest.map((s) => `  - ${s}`).join("\n") +
    `\n\nAbsorbed memories: ${ids}\n` +
    `The originals remain live and searchable; delete this summary if it is less\n` +
    `useful than they are. Condensed by daemon/memory-summarize.mjs.`
  );
}

function readLive() {
  // MUST mirror foldLog() in memory-mcp.js, not just accumulate.
  //
  // The first version did `live.set(r.id, {...prev, ...r.mem})`, which is wrong
  // in two ways that both showed up in the real store on 2026-10-01:
  //
  //   1. memory_update writes a NEW record with the SAME id, so the latest
  //      revision replaces the older one. Merging them resurrects fields the
  //      update deliberately dropped, and reports a higher memory count than
  //      the MCP will actually return (26 vs 21 here).
  //   2. A `forget` removes the id from the live set entirely.
  //
  // foldLog keys on mem.id and lets later puts win, which is the authoritative
  // behaviour. Mirroring it exactly is the whole point: this tool summarises
  // what recall will actually see, not what the file happens to contain.
  return fs
    .readFile(MEMORY_FILE, "utf8")
    .then((raw) => {
      const byId = new Map();
      const order = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // torn tail or garbage; the MCP tolerates the same
        }
        const op = rec.op || (rec.id && rec.content ? "put" : null);
        if (!op) continue;
        if (op === "put") {
          const mem = rec.mem || (rec.op ? null : rec);
          if (!mem?.id) continue;
          if (!byId.has(mem.id)) order.push(mem.id);
          byId.set(mem.id, mem); // later revision wins, matching foldLog
        } else if (op === "forget") {
          byId.delete(rec.id);
          const i = order.indexOf(rec.id);
          if (i !== -1) order.splice(i, 1);
        }
      }
      return order.map((id) => byId.get(id)).filter(Boolean);
    });
}

const argv = process.argv.slice(2);
const opts = { ...DEFAULTS };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--apply") opts.apply = true;
  else if (argv[i] === "--dry-run") opts.apply = false;
  else if (argv[i] === "--report-json") opts.json = true;
  else if (argv[i] === "--threshold") opts.threshold = Number(argv[++i]);
  else if (argv[i] === "--min-group") opts.minGroup = Number(argv[++i]);
}

const live = await readLive();
const groups = groupBySimilarity(live, opts.threshold).filter((g) => g.length >= opts.minGroup);

// Skip any group containing an existing summary, so a summary is never fed into
// another summary. Errors must not compound across runs.
const candidates = [];
const skipped = [];
for (const members of groups) {
  if (members.some(isSummary)) {
    // Reported rather than silently dropped: a group disappearing with no
    // explanation is indistinguishable from a grouping bug.
    skipped.push({
      ids: members.map((m) => m.id),
      because: members.filter(isSummary).map((m) => m.id)
    });
    continue;
  }
  const digest = condense(members);
  if (digest.length) candidates.push({ members, digest });
}

// Machine-readable output for the test suite. Reports what WOULD be written and
// what WOULD be grouped, without writing.
if (opts.json) {
  console.log(
    JSON.stringify({
      liveCount: live.length,
      ids: live.map((m) => m.id),
      groups: candidates.map((c) => ({
        ids: c.members.map((m) => m.id),
        digest: c.digest,
        topic: topicTerms(c.members)
      })),
      skipped
    })
  );
  process.exit(0);
}

console.log(`store: ${live.length} live memories from ${MEMORY_FILE}`);
console.log(`mode:  ${opts.apply ? "APPLY (will write)" : "report only (pass --apply to write)"}`);
console.log(`grouping: token-overlap >= ${opts.threshold}%, min group ${opts.minGroup}\n`);

if (!candidates.length) {
  console.log(
    groups.length
      ? "groups found, but none summarizable (all contain an existing summary)."
      : "no groups met the threshold. nothing to do."
  );
  process.exit(0);
}

const summaries = [];
for (const c of candidates) {
  const skipped = c.members.filter(isSummary);
  if (skipped.length) continue;
  summaries.push({ members: c.members, text: buildSummaryText(c.members, c.digest) });
  console.log(`GROUP ${c.members.length} memories  [${topicTerms(c.members).join(", ")}]`);
  for (const m of c.members) {
    console.log(`   ${String(m.id).slice(0, 8)} (${m.type}, imp ${m.importance ?? "?"}) ${String(m.content).slice(0, 84).replace(/\n/g, " ")}`);
  }
  console.log(`   -> ${c.digest.length} sentences, ${c.digest.join(" ").length} chars\n`);
}

console.log(`${summaries.length} summarizable group(s) out of ${groups.length} candidate(s).`);

if (!opts.apply) {
  console.log("\nnothing written. re-run with --apply to append these summaries.");
  process.exit(0);
}

if (!summaries.length) {
  console.log("nothing to write.");
  process.exit(0);
}

// Append via the MCP's own appendOp so the schema and torn-tail handling stay
// identical to a normal store/update -- no second code path for the log format.
// MEMORY_FILE is passed explicitly: appendOp defaults to the real store, so
// omitting it would let a test run with an override write to the real memory
// log. That is the one way this tool could actually do damage.
// pathToFileURL, not the bare path: a Windows absolute path is parsed as a URL
// with scheme "c:" and the ESM loader rejects it. Works on Linux either way,
// so only Windows was ever affected.
const { appendOp } = await import(
  pathToFileURL(path.join(REPO_DIR, "termux-mcp", "memory-mcp.js")).href
);

const ids = [];
for (const s of summaries) {
  const id = crypto.randomUUID();
  const terms = topicTerms(s.members, 8);
  const imp = Math.max(...s.members.map((m) => Number(m.importance) || 0.5));
  await appendOp(
    {
      op: "put",
      id,
      mem: {
        id,
        v: 1,
        type: "project",
        content: s.text,
        importance: Math.min(1, Math.round((imp + 0.05) * 100) / 100),
        confidence: 0.8,
        tags: ["summary", ...terms.slice(0, 5).map((t) => t.replace(/[^a-z0-9-]/g, ""))],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    },
    MEMORY_FILE
  );
  ids.push(`${String(id).slice(0, 8)} <- ${s.members.map((m) => String(m.id).slice(0, 8)).join(",")}`);
}
console.log(`\nwrote ${ids.length} summary memory(ies):`);
for (const i of ids) console.log(`  ${i}`);
console.log("\nno source memory was deleted. if a summary is wrong, forget the summary.");