/**
 * Tests for the scheduler's due-time logic.
 *
 * These functions are pure and exported for exactly this reason. The bug they
 * cover is a good example of what was previously untestable: the due check read
 * `job.nextRun`, a field that was only ever set on an in-memory object and
 * never persisted, so every process start saw `undefined`, judged every job
 * due, and fired all of them on every --once. The logic was buried inside
 * runDueJobs, behind a lock and a job run, so no test could reach it.
 *
 * Run: node --test daemon/scheduler.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isDue, computeNextRun } from "./scheduler.mjs";
import { readFileSync } from "node:fs";

const at = (iso) => new Date(iso);

// --- startup banner --------------------------------------------------------

// Found by the self-review job on 2026-10-01, then reproduced: an enabled job
// with no `schedule` (which is a supported shape -- `isDue` treats it as
// on-demand-only, and `serve()`'s registration loop skips it correctly) crashed
// the resident scheduler at startup with
//   TypeError: Cannot read properties of undefined (reading 'padEnd')
// because the banner dereferenced j.schedule unguarded. It threw BEFORE the
// keepAlive interval was created, so the process exited immediately rather than
// staying resident.
//
// serve() is not exported and spawns a daemon, so it cannot be called from a
// test directly. What is testable is the property that broke: the banner renders
// every enabled job, so no enabled job may reach it without a schedule.
test("the startup banner guards an enabled job that has no schedule", () => {
  const src = readFileSync(new URL("./scheduler.mjs", import.meta.url), "utf8");
  const bannerLine = src
    .split("\n")
    .find((l) => l.includes("active.map(") && l.includes("padEnd"));
  assert.ok(bannerLine, "expected to find the serve() startup banner");
  assert.doesNotMatch(
    bannerLine,
    /\$\{j\.schedule\.padEnd/,
    "j.schedule is dereferenced without a guard; an on-demand job crashes startup"
  );
  assert.match(bannerLine, /String\(j\.schedule \?\?/, "should fall back to a placeholder");
});

test("every renderer of a job line tolerates a missing schedule", () => {
  // Four places print a job row: the serve() banner, --dry-run, krieger list,
  // and krieger enable's error message. They drifted -- three guarded, one did
  // not -- which is exactly how this bug shipped. Lock all four together.
  const scheduler = readFileSync(new URL("./scheduler.mjs", import.meta.url), "utf8");
  const krieger = readFileSync(new URL("./krieger.mjs", import.meta.url), "utf8");
  for (const [name, src] of [["scheduler.mjs", scheduler], ["krieger.mjs", krieger]]) {
    for (const line of src.split("\n")) {
      if (!line.includes("padEnd(16)")) continue;
      if (line.includes("j.schedule.padEnd")) {
        assert.fail(`${name} has an unguarded j.schedule.padEnd: ${line.trim()}`);
      }
    }
  }
});

// --- isDue -----------------------------------------------------------------

test("a job with no schedule is never due", () => {
  // On-demand only, via `krieger run`. It used to fall through the due check
  // and fire on every single --once.
  const job = { name: "on-demand" };
  assert.equal(isDue(job, {}, { now: at("2030-01-01T00:00:00Z") }), false);
  assert.equal(isDue(job, {}, { force: true }), false,
    "force must not conjure a schedule onto an on-demand job");
});

test("a job that has never run is due", () => {
  const job = { name: "j", schedule: "0 7 * * *" };
  assert.equal(isDue(job, {}, { now: at("2030-01-01T00:00:00Z") }), true);
  assert.equal(isDue(job, undefined, { now: at("2030-01-01T00:00:00Z") }), true);
});

test("a job is not due before its next run time", () => {
  const job = { name: "j", schedule: "0 7 * * *" };
  const nextRun = { j: "2030-01-02T07:00:00.000Z" };
  assert.equal(isDue(job, nextRun, { now: at("2030-01-01T00:00:00Z") }), false);
});

test("a job is due once its next run time has passed", () => {
  const job = { name: "j", schedule: "0 7 * * *" };
  const nextRun = { j: "2030-01-02T07:00:00.000Z" };
  assert.equal(isDue(job, nextRun, { now: at("2030-01-02T07:00:01Z") }), true);
  // Exactly on the boundary counts as due.
  assert.equal(isDue(job, nextRun, { now: at("2030-01-02T07:00:00.000Z") }), true);
});

test("force makes a scheduled job due regardless of nextRun", () => {
  const job = { name: "j", schedule: "0 7 * * *" };
  const nextRun = { j: "2030-06-01T00:00:00.000Z" };
  assert.equal(isDue(job, nextRun, { force: true, now: at("2030-01-01T00:00:00Z") }), true);
});

test("a corrupt nextRun entry is due rather than wedging the job forever", () => {
  const job = { name: "j", schedule: "0 7 * * *" };
  assert.equal(isDue(job, { j: "not-a-date" }, { now: at("2030-01-01T00:00:00Z") }), true);
});

test("other jobs' entries do not make this job due", () => {
  const job = { name: "j", schedule: "0 7 * * *" };
  const nextRun = { somethingElse: "2030-01-02T07:00:00.000Z" };
  assert.equal(isDue(job, nextRun, { now: at("2030-01-01T00:00:00Z") }), true);
});

// --- computeNextRun --------------------------------------------------------

test("computeNextRun returns a future timestamp for a valid schedule", () => {
  const from = at("2030-01-01T10:00:00.000Z");
  const next = computeNextRun({ name: "j", schedule: "0 7 * * *" }, from);
  assert.ok(next instanceof Date, "expected a Date");
  assert.ok(next > from, `next run ${next} must be after ${from}`);
});

test("computeNextRun returns null for a job with no schedule", () => {
  assert.equal(computeNextRun({ name: "j" }, at("2030-01-01T10:00:00.000Z")), null);
});

test("computeNextRun returns null for an invalid schedule instead of throwing", () => {
  // A typo in one job must not wedge the whole scheduler.
  assert.equal(computeNextRun({ name: "j", schedule: "not a cron" }, new Date()), null);
  assert.equal(computeNextRun({ name: "j", schedule: "99 99 99" }, new Date()), null);
});

test("computeNextRun is repeatable and does not accumulate cron objects", () => {
  // Paused Cron instances must not hold the event loop open, or `scheduler
  // --once` would hang and the Android job would stack up processes. The
  // 10s timeout is the assertion: if this hangs, the test fails.
  const job = { name: "j", schedule: "*/5 * * * *" };
  const from = at("2030-01-01T10:00:00.000Z");
  const a = computeNextRun(job, from);
  const b = computeNextRun(job, from);
  assert.equal(a?.getTime(), b?.getTime(), "must be deterministic for a fixed `from`");
});
