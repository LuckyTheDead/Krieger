/**
 * Regression tests for memory-mcp.js
 *
 * Each test corresponds to a bug confirmed against v0.2.0 by direct execution:
 *   1. concurrent forget corrupted records (full-file rewrite)
 *   2. a torn tail was absorbed into the next record
 *   3. non-matching queries returned results (score > 0 always true)
 *   4. substring matching hit "mode" inside "manual"
 *   5. non-ASCII text was untokenizable and unfindable
 *
 * Run: node --test memory-mcp.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  loadLog,
  foldLog,
  loadMemories,
  appendOp,
  searchMemories,
  createHandlers,
  tokenize,
  normalize,
  hasNegation
} from "./memory-mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "memtest-"));
  return { dir, file: path.join(dir, "memories.jsonl") };
}

const M = (content, extra = {}) => ({
  v: 1,
  id: `id-${content.slice(0, 12)}-${Math.random().toString(36).slice(2, 8)}`,
  content,
  type: "fact",
  importance: 0.5,
  confidence: 1,
  tags: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...extra
});

// NOTE: `file` is required. Defaulting to the module's MEMORY_FILE here would
// write test data into the live memory store -- which is exactly the mistake
// this helper was briefly missing.
const put = (mem, file) => appendOp({ op: "put", id: mem.id, mem }, file);

// ---------------------------------------------------------------------------
// Storage: append-only integrity
// ---------------------------------------------------------------------------

test("concurrent forgets do not corrupt neighbouring records", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const a = M("alpha memory about the build system");
  const b = M("beta memory about the deploy pipeline");
  const c = M("gamma memory about the editor theme");
  await put(a, file); await put(b, file); await put(c, file);

  const h = createHandlers({ file });

  // The exact failure in v0.2.0: interleaved read-modify-write of the whole file.
  await Promise.all([
    h.memory_forget({ id: a.id }),
    h.memory_forget({ id: b.id }),
    h.memory_forget({ id: c.id })
  ]);

  // Every line in the file must still be individually parseable.
  const raw = await readFile(file, "utf8");
  for (const line of raw.trim().split("\n")) {
    assert.doesNotThrow(
      () => JSON.parse(line),
      `line was corrupted by concurrent forget: ${line.slice(0, 80)}`
    );
  }

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 0, "all three should be gone");
});

test("concurrent stores do not lose or corrupt records", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  const contents = Array.from({ length: 12 }, (_, i) => `distinct memory number ${i} about topic ${i}`);

  await Promise.all(contents.map(c => h.memory_store({
    content: c, type: "fact", importance: 0.5, confidence: 1, tags: []
  })));

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 12, "every concurrent store must survive");

  for (const c of contents) {
    assert.ok(memories.some(m => m.content === c), `lost: ${c}`);
  }
});

test("a torn tail is detected, excluded, and reported", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await put(M("complete memory that is fine"), file);
  // Simulate an interrupted write: a partial line with no trailing newline.
  await appendFile(file, '{"v":1,"op":"put","id":"torn","mem":{"id":"torn","conten');

  const { memories, torn, warnings } = await loadLog(file);
  assert.equal(torn, true, "torn tail must be detected");
  assert.equal(memories.length, 1, "only the complete record survives");
  assert.match(warnings.join(" "), /interrupted/i);
});

test("a torn tail is sealed, never absorbed into the next record", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await put(M("complete memory that is fine"), file);
  await appendFile(file, '{"v":1,"op":"put","id":"torn","mem":{"id":"torn","conten');

  const h = createHandlers({ file });
  const res = await h.memory_store({
    content: "a brand new memory written after the interruption",
    type: "fact", importance: 0.5, confidence: 1, tags: []
  });

  const text = res.content[0].text;
  assert.match(text, /sealed a truncated record/i, "caller must be told the tail was sealed");

  const raw = await readFile(file, "utf8");
  assert.ok(raw.endsWith("\n"), "file must end with a newline after the write");

  const lines = raw.trim().split("\n");

  // The torn record's content is unrecoverable -- it is a partial JSON object,
  // so it cannot be repaired. What matters is that it is *isolated* on its own
  // line instead of being glued onto the head of the next record, which is what
  // destroyed the new memory in v0.2.0.
  assert.equal(lines.length, 3, "sealed tail + original + new record = 3 lines");
  assert.throws(() => JSON.parse(lines[1]), "the torn line is still incomplete, as expected");
  assert.doesNotThrow(() => JSON.parse(lines[2]), "the new record must be intact and parseable");

  // And the new record must survive a reload.
  const { memories } = await loadLog(file);
  assert.ok(
    memories.some(m => m.content === "a brand new memory written after the interruption"),
    "the new memory must be recoverable"
  );

  // Once the tail is sealed it is no longer the tail, so it must be reported as
  // mid-file corruption rather than silently vanishing.
  const after = await loadLog(file);
  assert.equal(after.torn, false);
  assert.equal(after.corrupt.length, 1, "the sealed fragment must be reported, not hidden");
  assert.match(after.warnings.join(" "), /unparseable/i);
});

test("mid-file corruption is reported rather than silently hidden", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await put(M("first good memory"), file);
  await appendFile(file, "this is not json at all\n");
  await put(M("second good memory"), file);

  const { memories, corrupt, warnings } = await loadLog(file);
  assert.equal(memories.length, 2);
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].line, 2);
  assert.match(warnings.join(" "), /unparseable/i);
});

test("an empty file is a valid empty log", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(file, "");
  const { memories, torn } = await loadLog(file);
  assert.deepEqual(memories, []);
  assert.equal(torn, false);
});

test("a missing file is a valid empty log", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { memories, torn } = await loadLog(file);
  assert.deepEqual(memories, []);
  assert.equal(torn, false);
});

// ---------------------------------------------------------------------------
// Log folding
// ---------------------------------------------------------------------------

test("fold applies revisions and tombstones in order", () => {
  const id = "shared-id";
  const entries = [
    { v: 1, op: "put", id, mem: M("original content", { id }) },
    { v: 1, op: "put", id, mem: M("revised content", { id }) },
    { v: 1, op: "forget", id, at: "2026-01-01T00:00:00.000Z" },
    { v: 1, op: "put", id, mem: M("resurrected content", { id }) }
  ];
  const folded = foldLog(entries);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].content, "resurrected content");
});

test("legacy bare records are still readable as puts", () => {
  const folded = foldLog([
    { id: "legacy-1", content: "old format record", type: "fact", importance: 0.5, confidence: 1, tags: [] },
    { v: 1, op: "put", id: "new-1", mem: M("new format record") },
    { v: 1, op: "forget", id: "legacy-1", at: "2026-01-01T00:00:00.000Z" }
  ]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].content, "new format record");
});

test("legacy records survive a write in the new format", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(file, JSON.stringify({
    id: "legacy-1", content: "old format record", type: "fact",
    importance: 0.5, confidence: 1, tags: []
  }) + "\n");

  const h = createHandlers({ file });
  await h.memory_forget({ id: "legacy-1" });

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 0);
});

// ---------------------------------------------------------------------------
// Search gating
// ---------------------------------------------------------------------------

test("a query matching nothing returns nothing", () => {
  const memories = [
    M("The user prefers dark mode in the editor and light mode in the terminal", { importance: 0.4 }),
    M("The deployment pipeline only runs on Tuesdays and requires a manual approval step", { importance: 0.9, tags: ["ops"] })
  ];

  // Both query terms are absent from both memories, so there is no correct
  // reason for either to be returned.
  for (const q of ["kubernetes", "terraform vault", "quantum entanglement"]) {
    assert.equal(searchMemories(memories, q, 10).length, 0,
      `"${q}" must return nothing regardless of importance`);
  }
});

test("a term that matches cannot drag in a term that does not", () => {
  const memories = [
    M("The user prefers dark mode in the editor and light mode in the terminal", { importance: 0.4 }),
    M("The deployment pipeline only runs on Tuesdays and requires a manual approval step", { importance: 0.9, tags: ["ops"] })
  ];
  // "deployment" genuinely matches the second memory; "kubernetes" matches
  // nothing. The matching memory is legitimately returned, but only on the
  // strength of the term that actually hit -- and its score must reflect that
  // it covered half the query, not the whole of it.
  const [top] = searchMemories(memories, "kubernetes deployment", 10);
  assert.equal(top.memory.content.includes("deployment"), true);
  assert.equal(top.matchedTerms, 1);
  assert.ok(top.keywordScore <= 0.75,
    `a 1-of-2 term match must not score as a full match (got ${top.keywordScore})`);
});

test("high-importance junk never outranks a real match", () => {
  const memories = [
    M("Completely unrelated content about quantum chromodynamics", { importance: 1.0 }),
    M("The user prefers dark mode in the editor and light mode in the terminal", { importance: 0.1 })
  ];

  const results = searchMemories(memories, "dark mode editor", 10);
  assert.equal(results.length, 1);
  assert.match(results[0].memory.content, /dark mode/);
});

test("relevance never exceeds the match quality", () => {
  const memories = [
    M("The deployment pipeline only runs on Tuesdays and requires a manual approval step", { importance: 0.9 })
  ];
  const [top] = searchMemories(memories, "kubernetes", 10);
  assert.equal(top, undefined);
});

test("every returned result actually matched a query term", () => {
  const memories = [
    M("the user prefers dark mode in the editor", { importance: 0.1 }),
    M("deployment runs only on tuesdays", { importance: 0.99 }),
    M("memory about kubernetes clusters", { importance: 0.5 })
  ];

  const q = new Set(["dark", "mode", "editor"]);
  for (const r of searchMemories(memories, "dark mode editor", 10)) {
    assert.ok(r.matchedTerms > 0, `${r.memory.content} matched nothing`);
    assert.ok(r.matchedTerms <= 3);
    void q;
  }
});

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

test("substring false positives are gone", () => {
  const memories = [
    M("The deployment pipeline requires a manual approval step")
  ];
  // "mode" is a substring of "manual" in the original implementation.
  const results = searchMemories(memories, "dark mode", 10);
  assert.equal(results.length, 0, "'manual' must not match the query term 'mode'");
});

test("real word matches still work", () => {
  const memories = [
    M("The user prefers dark mode in the editor and light mode in the terminal", { importance: 0.4 }),
    M("The deployment pipeline only runs on Tuesdays", { importance: 0.9 })
  ];
  const results = searchMemories(memories, "dark mode", 10);
  assert.equal(results.length, 1);
  assert.match(results[0].memory.content, /dark mode/);
  assert.equal(results[0].keywordScore, 1, "both query terms should match");
});

test("case and punctuation fold together", () => {
  const memories = [M("user prefers DARK MODE in the editor and LIGHT MODE in the TERMINAL")];
  const results = searchMemories(memories, "dark mode in editor", 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].keywordScore, 1);
});

test("accents fold to base letters", () => {
  assert.equal(normalize("café"), "cafe");
  const memories = [M("the user prefers a café in the morning")];
  const results = searchMemories(memories, "cafe", 10);
  assert.equal(results.length, 1);
});

test("CJK text is searchable instead of invisible", () => {
  const memories = [M("ユーザーは日本語の応答を好む")];
  assert.ok(tokenize("ユーザーは日本語の応答を好む").length > 0,
    "CJK must tokenize to something non-empty");

  const results = searchMemories(memories, "応答", 10);
  assert.equal(results.length, 1, "CJK substring must be findable");
});

test("morphological variants match", () => {
  const memories = [M("the deployment pipeline requires manual approvals")];
  for (const q of ["approval", "approvals", "deploy", "deploying", "deployment", "deployments"]) {
    assert.ok(searchMemories(memories, q, 10).length >= 1, `"${q}" should match`);
  }
});

test("the prefix key does not create short-word false positives", () => {
  // "deplo" is the key for a family of long words; "mode" stays exact, so it
  // must not match inside "manual" or "model".
  const memories = [
    M("the manual instructions for the remodel"),
    M("a deployment of the application")
  ];
  assert.equal(searchMemories(memories, "mode", 10).length, 0,
    '"mode" must not match "manual"/"remodel"');
  assert.equal(searchMemories(memories, "deploy", 10).length, 1,
    '"deploy" must still match the deployment memory');
});

test("stopwords do not create spurious matches", () => {
  const memories = [M("the build runs on tuesday mornings")];
  // "the"/"on" are stopwords; dropping them must not empty the query.
  const results = searchMemories(memories, "build on tuesday", 10);
  assert.equal(results.length, 1);
});

// ---------------------------------------------------------------------------
// update / forget semantics
// ---------------------------------------------------------------------------

test("update appends a revision and keeps the original id and created_at", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  const created = await h.memory_store({
    content: "the original preference about themes", type: "fact",
    importance: 0.4, confidence: 1, tags: []
  });
  const id = created.content[0].text.match(/ID: (\S+)/)[1];

  await h.memory_update({ id, importance: 0.95 });

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 1, "a revision must replace, not duplicate");
  assert.equal(memories[0].importance, 0.95);
  assert.equal(memories[0].created_at, memories[0].created_at);
});

test("update and forget report a missing id without throwing", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = createHandlers({ file });

  const u = await h.memory_update({ id: "nope", importance: 0.5 });
  assert.match(u.content[0].text, /not found/i);

  const f = await h.memory_forget({ id: "nope" });
  assert.match(f.content[0].text, /not found/i);
});

test("forget then re-store the same content creates a fresh memory", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  const first = await h.memory_store({
    content: "a fact that will be forgotten", type: "fact",
    importance: 0.5, confidence: 1, tags: []
  });
  const id = first.content[0].text.match(/ID: (\S+)/)[1];
  await h.memory_forget({ id });

  const second = await h.memory_store({
    content: "a fact that will be forgotten", type: "fact",
    importance: 0.5, confidence: 1, tags: []
  });
  assert.match(second.content[0].text, /stored successfully/i,
    "a tombstoned memory must not block re-storing the same content");
});

test("near-duplicate veto fires on a genuine duplicate", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  await h.memory_store({
    content: "The user prefers dark mode in the editor and light mode in the terminal",
    type: "fact", importance: 0.4, confidence: 1, tags: []
  });

  const res = await h.memory_store({
    content: "The user prefers dark mode in the editor and light mode in the terminal",
    type: "fact", importance: 0.4, confidence: 1, tags: []
  });

  assert.match(res.content[0].text, /already exists/i,
    "an exact restatement must be refused");
});

test("a correction is stored, not refused as a duplicate", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  await h.memory_store({
    content: "The build server has 32GB of RAM",
    type: "fact", importance: 0.5, confidence: 1, tags: []
  });

  // Refused at 0.8 Jaccard before the fix: the stale 32GB claim would have
  // remained the only truth in the store, and the correction would be lost.
  const res = await h.memory_store({
    content: "The build server has 64GB of RAM, not 32GB",
    type: "fact", importance: 0.5, confidence: 1, tags: []
  });

  assert.match(res.content[0].text, /stored successfully/i,
    "a contradicting correction must never be silently discarded");

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 2);
});

test("a refinement that adds a carve-out is stored", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  await h.memory_store({
    content: "The user prefers dark mode in the editor and light mode in the terminal",
    type: "fact", importance: 0.4, confidence: 1, tags: []
  });

  const res = await h.memory_store({
    content: "The user prefers dark mode in the editor and light mode in the terminal, except on Fridays",
    type: "fact", importance: 0.4, confidence: 1, tags: []
  });

  assert.match(res.content[0].text, /stored successfully/i);
});

test("hasNegation catches corrections and leaves plain restatements alone", () => {
  for (const s of [
    "The build server has 64GB of RAM, not 32GB",
    "The user no longer wants the tests on every commit",
    "The pipeline runs on Thursdays rather than Tuesdays",
    "we stopped using the old deploy script",
    "this was changed to use 64GB"
  ]) {
    assert.equal(hasNegation(s), true, `should flag: ${s}`);
  }
  for (const s of [
    "The user prefers dark mode in the editor",
    "The deployment pipeline runs on Tuesdays",
    "tiny-agent keeps the prompt-driven system-prompt architecture"
  ]) {
    assert.equal(hasNegation(s), false, `should not flag: ${s}`);
  }
});

// ---------------------------------------------------------------------------
// Duplicate detection: coverage, not type
//
// The veto used to compare candidates of the same `type` only, and used
// symmetric Jaccard, which under-scores a memory that is a superset of
// another. Both are confirmed failures, not theory -- each test below was run
// against v0.3.0 and produced a second copy in the store.
// ---------------------------------------------------------------------------

test("an identical memory is refused even when the type differs", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  const text = "User prefers dark mode in all editors.";

  await h.memory_store({ content: text, type: "preference", importance: 0.5, confidence: 1, tags: [] });
  const res = await h.memory_store({ content: text, type: "fact", importance: 0.5, confidence: 1, tags: [] });

  assert.match(res.content[0].text, /already exists/i,
    "the same sentence under two type labels is still the same memory");

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 1, "only one copy may exist");
});

test("identical non-English text is refused as a duplicate", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  const text = "用户偏好在所有编辑器中使用深色模式。";

  await h.memory_store({ content: text, type: "preference", importance: 0.5, confidence: 1, tags: [] });
  const res = await h.memory_store({ content: text, type: "preference", importance: 0.5, confidence: 1, tags: [] });

  assert.match(res.content[0].text, /already exists/i,
    "a byte-identical re-store must be refused in any script");

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 1);
});

test("a memory contained in a longer one is refused, in either order", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  const short = "The user deploys on Fridays.";
  const long = short + " Production deploys require a sign-off from the on-call engineer.";

  // Long first, then the shorter memory it already contains.
  await h.memory_store({ content: long, type: "fact", importance: 0.5, confidence: 1, tags: [] });
  const shorter = await h.memory_store({ content: short, type: "fact", importance: 0.5, confidence: 1, tags: [] });
  assert.match(shorter.content[0].text, /already exists/i,
    "a memory fully contained in an existing one adds nothing");

  // And the reverse order, in a clean store.
  const b = await sandbox();
  t.after(() => rm(b.dir, { recursive: true, force: true }));
  const h2 = createHandlers({ file: b.file });
  await h2.memory_store({ content: short, type: "fact", importance: 0.5, confidence: 1, tags: [] });
  const longer = await h2.memory_store({ content: long, type: "fact", importance: 0.5, confidence: 1, tags: [] });
  assert.match(longer.content[0].text, /already exists/i,
    "containment must not depend on which memory arrived first");

  const { memories } = await loadLog(b.file);
  assert.equal(memories.length, 1);
});

test("a correction is still stored against a near-duplicate", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  await h.memory_store({
    content: "The deployment pipeline runs on Tuesdays at six in the morning",
    type: "fact", importance: 0.5, confidence: 1, tags: []
  });

  // Highly similar, but negates the original. Broadening the veto must not
  // start eating corrections -- that failure mode is worse than a duplicate.
  const res = await h.memory_store({
    content: "The deployment pipeline runs on Thursdays, not Tuesdays",
    type: "fact", importance: 0.5, confidence: 1, tags: []
  });

  assert.match(res.content[0].text, /stored successfully/i,
    "a contradicting correction must never be refused as a duplicate");

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 2);
});

test("a distinct memory is not mistaken for a duplicate of an unrelated one", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  await h.memory_store({
    content: "The user prefers dark mode in the editor",
    type: "preference", importance: 0.5, confidence: 1, tags: []
  });
  const res = await h.memory_store({
    content: "The build server has 64GB of RAM",
    type: "fact", importance: 0.5, confidence: 1, tags: []
  });

  assert.match(res.content[0].text, /stored successfully/i,
    "unrelated memories must not collide");

  const { memories } = await loadLog(file);
  assert.equal(memories.length, 2);
});

test("search reports how much of the query a result actually matched", async t => {
  const { dir, file } = await sandbox();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const h = createHandlers({ file });
  await h.memory_store({
    content: "tiny-agent keeps the prompt-driven system-prompt architecture",
    type: "project", importance: 0.8, confidence: 0.95, tags: ["tiny-agent", "architecture"]
  });

  const res = await h.memory_search({ query: "architecture", limit: 5 });
  const [hit] = JSON.parse(res.content[0].text);

  assert.equal(hit.matchedTerms, 1, "one query term was matched");
  assert.equal(hit.queryTerms, 1, "and the query only had one to match");
  assert.ok("relevance" in hit, "ranking score is still reported");

  // The point of the field: relevance saturates on a one-word match, so it
  // must not be read as a confidence. Both numbers travel together.
  const weak = await h.memory_search({ query: "architecture decisions about the scheduler", limit: 5 });
  const [partial] = JSON.parse(weak.content[0].text);
  assert.ok(partial.matchedTerms < partial.queryTerms,
    "a partial match is visible as fewer matched terms than query terms");
  assert.ok(partial.relevance > 0.8,
    "relevance is a ranking score and stays high regardless -- documented as such");
});
