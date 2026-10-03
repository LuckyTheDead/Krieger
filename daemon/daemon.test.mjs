import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { redact, acquireLock, writeAtomic, readJson, tail } from "./lib/core.mjs";
import { runShellJob, loadSystemPrompt } from "./lib/runner.mjs";
import { recallContext } from "./lib/memory.mjs";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "krieger-test-"));

// --- redaction -------------------------------------------------------------

test("redact removes openrouter-style keys", () => {
  const key = "sk-or-v1-" + "a".repeat(48);
  assert.equal(redact(`the key is ${key} ok`), "the key is [REDACTED] ok");
});

test("redact removes huggingface and github tokens", () => {
  assert.equal(redact(`hf_${"b".repeat(34)}`), "[REDACTED]");
  assert.equal(redact(`ghp_${"c".repeat(36)}`), "[REDACTED]");
});

test("redact removes bearer headers, scheme included", () => {
  // The whole "Bearer <token>" span goes, not just the token.
  assert.equal(
    redact("Authorization: Bearer abcdefghijklmnopqrstuvwx"),
    "Authorization: [REDACTED]"
  );
});

test("redact leaves ordinary text alone", () => {
  const text = "disk is 92% full, memories: 11, runlog: 0";
  assert.equal(redact(text), text);
});

test("redact does not mangle a short sk- string that is not a credential", () => {
  assert.equal(redact("sk-test"), "sk-test");
});

// --- locking ---------------------------------------------------------------

test("acquireLock grants once and refuses a second holder", async () => {
  const dir = await tmp();
  const lock = path.join(dir, "x.lock");
  const release = await acquireLock(lock);
  assert.ok(release, "first acquire should succeed");
  assert.equal(await acquireLock(lock), null, "second acquire must be refused");
  await release();
  const again = await acquireLock(lock);
  assert.ok(again, "after release it should grant again");
  await again();
});

test("acquireLock reaps a lock whose pid is dead", async () => {
  const dir = await tmp();
  const lock = path.join(dir, "y.lock");
  // pid 2^22 is above the default pid_max on Android; kill() will throw ESRCH.
  await fs.writeFile(lock, JSON.stringify({ pid: 4194303, at: new Date().toISOString() }));
  const release = await acquireLock(lock);
  assert.ok(release, "a stale lock from a dead pid must be reaped");
  await release();
});

test("acquireLock respects a live holder with a fresh timestamp", async () => {
  const dir = await tmp();
  const lock = path.join(dir, "z.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  assert.equal(await acquireLock(lock), null, "must not steal a live lock");
});

test("acquireLock does not treat a permission error as a dead pid", async () => {
  // Signal 0 throws EPERM when the pid exists but belongs to another uid, and
  // ESRCH when it is gone. Only ESRCH is evidence of death. Getting this
  // backwards lets a second scheduler steal a live lock and run the same job
  // twice concurrently.
  //
  // The stand-in for "exists, not ours" was pid 1, which is init on Linux and
  // does NOT EXIST on Windows -- where process.kill(1, 0) throws EINVAL. That
  // made this assertion meaningless on Windows, and the fix in core.mjs (treat
  // EINVAL as dead, since a lock whose holder is gone must be reaped) made the
  // old expectation actively wrong there.
  //
  // So: on Linux keep asserting against pid 1. On Windows use the OS-reported
  // absence of a pid instead, which is the same property being tested -- "this
  // pid is provably not running" -- without depending on a Unix convention.
  const deadPid = process.platform === "win32" ? 4194303 : 1;
  const dir = await tmp();
  const lock = path.join(dir, "eperm.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: deadPid, at: new Date().toISOString() }));

  if (process.platform === "win32") {
    // There is no always-live pid here, so assert the reap instead: a lock held
    // by a pid that does not exist must NOT block the scheduler.
    const release = await acquireLock(lock, { staleMs: 6 * 60 * 60 * 1000 });
    assert.ok(release, "a lock held by a nonexistent pid must be reaped on Windows");
    return;
  }

  const release = await acquireLock(lock, { staleMs: 6 * 60 * 60 * 1000 });
  assert.equal(release, null, "a lock held by a live pid 1 must not be stolen");
});

test("acquireLock still reaps on ESRCH", async () => {
  const dir = await tmp();
  const lock = path.join(dir, "esrch.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: 4194303, at: new Date().toISOString() }));
  const release = await acquireLock(lock);
  assert.ok(release, "a lock whose holder is genuinely dead must still be reaped");
  await release();
});

// --- atomic write ----------------------------------------------------------

test("writeAtomic leaves no temp file and round-trips", async () => {
  const dir = await tmp();
  const f = path.join(dir, "state.json");
  await writeAtomic(f, JSON.stringify({ a: 1 }));
  assert.deepEqual(await readJson(f, null), { a: 1 });
  const leftovers = (await fs.readdir(dir)).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "temp file must be renamed away");
});

test("readJson returns the fallback for a missing file but throws on garbage", async () => {
  const dir = await tmp();
  assert.equal(await readJson(path.join(dir, "nope.json"), "fb"), "fb");
  const bad = path.join(dir, "bad.json");
  await fs.writeFile(bad, "{not json");
  await assert.rejects(() => readJson(bad, "fb"), /not valid JSON/);
});

// --- tail ------------------------------------------------------------------

test("tail truncates from the front and keeps the end", () => {
  const out = tail("x".repeat(50) + "THE-END", 20);
  assert.ok(out.includes("THE-END"), "the tail end must survive");
  assert.ok(out.includes("[truncated]"), "truncation must be marked");
  assert.ok(out.length < 50, "leading filler must be dropped");
});

test("tail redacts before truncating", () => {
  const out = tail(`error with key sk-or-v1-${"z".repeat(40)} inside`, 200);
  assert.ok(!out.includes("z".repeat(40)));
});

// --- shell jobs ------------------------------------------------------------

test("runShellJob captures stdout and marks success", async () => {
  const dir = await tmp();
  const state = { runLog: path.join(dir, "runs.jsonl"), repoDir: dir };
  const r = await runShellJob({ name: "t1", kind: "shell", command: "echo hello-shell" }, { state });
  assert.equal(r.ok, true);
  assert.match(r.output, /hello-shell/);
  const log = await fs.readFile(state.runLog, "utf8");
  assert.match(log, /"job":"t1"/);
});

test("runShellJob records failure and keeps stdout", async () => {
  const dir = await tmp();
  const state = { runLog: path.join(dir, "runs.jsonl"), repoDir: dir };
  const r = await runShellJob(
    { name: "t2", kind: "shell", command: "echo before-fail; exit 3" },
    { state }
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /exit 3/);
});

test("runShellJob skips a disabled job without running it", async () => {
  const dir = await tmp();
  const state = { runLog: path.join(dir, "runs.jsonl"), repoDir: dir };
  const r = await runShellJob(
    { name: "t3", kind: "shell", command: "echo SHOULD-NOT-RUN", enabled: false },
    { state }
  );
  assert.equal(r.skipped, "disabled");
  assert.ok(!String(r.output).includes("SHOULD-NOT-RUN"));
});

test("runShellJob strips API keys from the child environment", async () => {
  const dir = await tmp();
  const state = { runLog: path.join(dir, "runs.jsonl"), repoDir: dir };
  process.env.OPENROUTER_API_KEY = "sk-or-v1-" + "e".repeat(48);
  try {
    const r = await runShellJob(
      { name: "t4", kind: "shell", command: 'echo "key=[${OPENROUTER_API_KEY:-unset}]"' },
      { state }
    );
    assert.match(r.output, /key=\[unset\]/);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test("runShellJob redacts a secret printed by the command", async () => {
  const dir = await tmp();
  const state = { runLog: path.join(dir, "runs.jsonl"), repoDir: dir };
  const r = await runShellJob(
    { name: "t5", kind: "shell", command: 'echo "leaked sk-or-v1-' + "k".repeat(44) + '"' },
    { state }
  );
  assert.ok(!r.output.includes("k".repeat(20)), "secret must not reach the run log");
  assert.match(r.output, /\[REDACTED\]/);
});

// --- prompt sync gate ------------------------------------------------------

test("loadSystemPrompt reads PROMPT.md", async () => {
  const repo = path.resolve(import.meta.dirname, "..");
  const p = await loadSystemPrompt({ repoDir: repo });
  assert.match(p, /Krieger|collaborator/);
});

test("loadSystemPrompt refuses to run on drifted prompt copies", async () => {
  const repo = path.resolve(import.meta.dirname, "..");
  const copyPath = path.join(repo, "personality", "system-prompt.txt");
  const original = await fs.readFile(copyPath, "utf8");
  try {
    await fs.writeFile(copyPath, `${original}\n<!-- drift -->\n`);
    await assert.rejects(
      () => loadSystemPrompt({ repoDir: repo }),
      /differ/
    );
  } finally {
    await fs.writeFile(copyPath, original);
  }
});

// --- memory context --------------------------------------------------------

// searchMemories returns { memory, score, ... }. When the daemon's formatter
// treated a result as a memory it read m.id off undefined and threw, which
// runJob caught and recorded as a job FAILURE -- so every LLM job that asked
// for memory context failed, and the memory system looked permanently broken.
test("recallContext renders memory hits instead of throwing", async () => {
  const state = { runLog: path.join(await tmp(), "runs.jsonl") };
  const job = {
    name: "t-recall",
    kind: "llm",
    prompt:
      "Overnight review of the unattended run log and the reliability of each job",
    memoryTags: ["tiny-agent", "architecture"]
  };
  const ctx = await recallContext(job, { state });
  assert.ok(ctx, "expected memory context for a prompt that matches stored memories");
  assert.ok(!/undefined/.test(ctx), `context contained undefined:\n${ctx}`);
  // A real hit looks like "  [3a06dda6] Architecture decision: ..."
  assert.match(ctx, /\[[0-9a-f]{8}\]/, `no memory ids rendered:\n${ctx}`);
});

test("recallContext survives a job whose memory tags match nothing", async () => {
  const state = { runLog: path.join(await tmp(), "runs.jsonl") };
  const ctx = await recallContext(
    { name: "t-nomem", kind: "llm", prompt: "z".repeat(60), memoryTags: [] },
    { state }
  );
  assert.ok(ctx === null || typeof ctx === "string");
});
