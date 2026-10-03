/**
 * Tests for daemon/memory-summarize.mjs.
 *
 * The hard parts of this tool are all cases where it would be SILENTLY wrong:
 * grouping unrelated memories, shredding file paths when splitting sentences,
 * and counting memories the MCP will not return. Each of those happened during
 * the build, so each is pinned here.
 *
 * Run: node --test daemon/memory-summarize.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, "memory-summarize.mjs");

const REAL_STORE = path.resolve(HERE, "..", "memory", "memories.jsonl");

async function withStore(records, fn, extraArgs = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-sum-"));
  const file = path.join(dir, "memories.jsonl");
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const out = await execFileAsync(process.execPath, [TOOL, "--report-json", ...extraArgs], {
    env: { ...process.env, KRIEGER_MEMORY_FILE: file }
  });
  return JSON.parse(out.stdout);
}

const mem = (id, content, tags = [], importance = 0.6) => ({
  v: 1,
  op: "put",
  id,
  mem: { id, v: 1, type: "project", content, tags, importance, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }
});

// --- counting mirrors foldLog ----------------------------------------------

test("an updated memory is counted once, at its latest revision", async () => {
  // memory_update writes a NEW record with the SAME id. The first version merged
  // revisions and reported 26 memories where the MCP returned 21, so it would
  // have summarised fields the update deliberately dropped.
  const json = await withStore([
    mem("a", "original content about the scheduler banner and cron schedules"),
    { v: 1, op: "put", id: "a", mem: { id: "a", v: 1, type: "project", content: "REVISED content", tags: [], importance: 0.6 } }
  ], async () => {});
  assert.equal(json.liveCount, 1);
  assert.equal(json.ids[0], "a");
});

test("a forgotten memory is excluded", async () => {
  const json = await withStore([
    mem("a", "keep this one about the scheduler banner"),
    mem("b", "drop this one about the scheduler banner"),
    { v: 1, op: "forget", id: "b" }
  ], async () => {});
  assert.equal(json.liveCount, 1);
  assert.deepEqual(json.ids, ["a"]);
});

// --- grouping --------------------------------------------------------------

test("a memory is never grouped with itself as a group of one", async () => {
  const json = await withStore([mem("solo", "a completely unique statement about quantum widgets")], async () => {});
  assert.equal(json.liveCount, 1);
  assert.equal(json.groups.length, 0, "a single memory is not summarizable");
});

test("unrelated memories are not grouped", async () => {
  const json = await withStore([
    mem("a", "the ARC prize deadline is November eighth for papers"),
    mem("b", "the sshd configuration listens on port 8022 loopback only")
  ], async () => {});
  assert.equal(json.groups.length, 0, "ARC deadlines and sshd are different topics");
});

test("overlapping memories are grouped and report their sources", async () => {
  const json = await withStore([
    mem("a", "the prompt-sync guard fails when PROMPT.md and the personality copy drift apart"),
    mem("b", "prompt-sync guard added to enforce that PROMPT.md stays byte-identical to the copy")
  ], async () => {});
  assert.equal(json.groups.length, 1);
  assert.deepEqual(json.groups[0].ids.sort(), ["a", "b"]);
});

test("an existing summary is never used as a summarization source", async () => {
  // Compounding a lossy summary is how a wrong detail becomes silently wronger.
  // The fixture is deliberately verbose: grouping is token-overlap based, so two
  // short sentences can fall below threshold and silently test nothing.
  const json = await withStore([
    mem(
      "s",
      "[SUMMARY OF 2 MEMORIES] condensed from earlier records about the prompt-sync guard that keeps PROMPT.md byte-identical to the personality copy so a session cannot load a stale persona.",
      ["summary"]
    ),
    mem(
      "a",
      "Architecture decision: tiny-agent keeps the prompt-driven system-prompt architecture. The system prompt is a markdown file (PROMPT.md) rather than something assembled in code, and a prompt-sync guard test fails if the two copies drift apart."
    ),
    mem(
      "b",
      "tiny-agent has a prompt-sync guard at prompt-sync.test.mjs enforcing the prompt-driven system-prompt architecture: it fails if PROMPT.md and personality/system-prompt.txt are not byte-identical, or if an honesty section is removed."
    )
  ], async () => {}, ["--threshold", "20"]);
  // The group IS found, then deliberately skipped because it contains a summary.
  // Asserting on `skipped` rather than `groups` is what makes this test real: a
  // group vanishing from both lists would look identical to a correct skip, and
  // that is the failure mode worth catching.
  assert.equal(json.groups.length, 0, "the summary must not be condensed again");
  assert.equal(json.skipped.length, 1, "the skipped group must be reported, not silently dropped");
  assert.ok(json.skipped[0].ids.includes("s"));
  assert.deepEqual(json.skipped[0].because, ["s"]);
});

// --- sentence splitting ---------------------------------------------------

test("a file path is not mistaken for a sentence boundary", async () => {
  // The original regex split on every . followed by anything, turning
  // "(PROMPT.md) rather than assembled" into "(PROMPT." + "mjs..." -- which
  // corrupted the first summary of all three groups on the first real run.
  const json = await withStore([
    mem(
      "a",
      "Architecture decision: tiny-agent keeps the prompt-driven system-prompt architecture. The system prompt is a markdown file (PROMPT.md) rather than something assembled in code, so the prompt-sync guard can compare two files byte for byte."
    ),
    mem(
      "b",
      "The prompt-sync guard at prompt-sync.test.mjs enforces the prompt-driven system-prompt architecture: it fails if PROMPT.md and personality/system-prompt.txt are not byte-identical, because an edit to one could silently drift from the other."
    )
  ], async () => {});
  assert.equal(json.groups.length, 1, "fixture must group");
  const text = json.groups[0].digest.join(" ");
  assert.ok(text.length > 0, "a group must produce a digest");
  assert.doesNotMatch(text, /\(PROMPT\.$/, "must not end a sentence mid-path");
  assert.doesNotMatch(text, /PROMPT\.(\s|$)/, "PROMPT.md must not be truncated to PROMPT.");
  assert.doesNotMatch(text, /test\.mjs\b(?! )/, "must not split mjs onto a new sentence");
  assert.ok(text.includes("PROMPT.md"), `the path should survive whole, got: ${text.slice(0, 200)}`);
});

test("abbreviations and ellipses do not end a sentence", async () => {
  const json = await withStore([
    mem(
      "a",
      "Disk usage on this device is the binding constraint, e.g. the run log grows without bound and nothing prunes it, etc. A hygiene job notifies once the filesystem crosses ninety percent full."
    ),
    mem(
      "b",
      "The binding constraint is disk space, i.e. the run log grows unbounded. A hygiene script checks the filesystem and warns above the threshold so the daemon stops accepting work it cannot log."
    )
  ], async () => {}, ["--threshold", "20"]);
  assert.equal(json.groups.length, 1, "fixture must group");
  const text = json.groups[0].digest.join(" ");
  assert.doesNotMatch(text, /\be\.g\.?$/m, "e.g. should not terminate a sentence");
  assert.doesNotMatch(text, /\betc\.?$/m, "etc. should not terminate a sentence");
  assert.doesNotMatch(text, /\bi\.e\.?$/m, "i.e. should not terminate a sentence");
});

// --- report-only by default ----------------------------------------------

test("no --apply means no writes to the store", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-sum-ro-"));
  const file = path.join(dir, "memories.jsonl");
  const records = [
    mem("a", "the prompt-sync guard fails when PROMPT.md and the personality copy drift"),
    mem("b", "prompt-sync guard enforces PROMPT.md byte-identical to the copy")
  ];
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const before = await fs.readFile(file, "utf8");
  await execFileAsync(process.execPath, [TOOL], { env: { ...process.env, KRIEGER_MEMORY_FILE: file } });
  assert.equal(await fs.readFile(file, "utf8"), before, "report mode must not write");
});

// --- the real store --------------------------------------------------------

test("the tool reads the real store without counting revisions twice", async () => {
  const out = await execFileAsync(process.execPath, [TOOL, "--report-json"]);
  const json = JSON.parse(out.stdout);
  // pathToFileURL, not the bare path: a Windows absolute path like
  // C:\...\memory-mcp.js is read as a URL with scheme "c:" and the ESM loader
  // rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME. On Linux both forms work,
  // so this only ever broke on Windows -- found by running these tests there.
  const mcp = await import(
    pathToFileURL(path.join(HERE, "..", "termux-mcp", "memory-mcp.js")).href
  );
  const { memories } = await mcp.loadLog();
  assert.equal(
    json.liveCount,
    memories.length,
    "summarizer and memory MCP must agree on how many memories are live"
  );
  void REAL_STORE;
});
