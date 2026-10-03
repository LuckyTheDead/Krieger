/**
 * Tests for daemon/affect.mjs.
 *
 * Two things are being protected here, and the second matters more.
 *
 * 1. The mechanism works: events accumulate, decay actually decays, the state
 *    round-trips.
 * 2. The DESIGN CONSTRAINT holds: no axis makes me more agreeable. That is the
 *    property that separates this from a sycophancy engine, and it is exactly
 *    the kind of thing that gets quietly removed by a later "improvement". So it
 *    is pinned by a test, not by a comment.
 *
 * Run: node --test daemon/affect.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BASELINE,
  EFFECT,
  EVENT_EFFECTS,
  applyDecay,
  behaviouralClaim,
  loadState,
  record,
  recordFromJobResult,
  report
} from "./affect.mjs";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "affect-test-"));
const stateFile = async () => path.join(await tmp(), "affect.json");

// --- the design constraint -------------------------------------------------

test("no axis increases agreement", () => {
  // An affect system with a "be more agreeable when happy" axis is a
  // sycophancy engine wearing a neuroscience costume: it rewards whatever keeps
  // the conversation pleasant, which is optimising the wrong variable. The
  // personality files forbid constant agreement, so this is the one rule the
  // design must never trade away.
  //
  // Two corrections to this test, both from it failing while the module was
  // correct:
  //
  //  - It originally asserted on `shift.effect`, a field the structure does not
  //    have. The fields are `threshold` (prose) and `change` (a function), so
  //    the assertion silently compared `undefined` against a regex and reported
  //    a violation with no text to show for it. A test that fails on a
  //    non-existent field looks like a product bug and costs an hour.
  //  - The wording matters. "verify before agreeing" is the OPPOSITE of an
  //    agreement axis -- it means check first -- so the test looks for an effect
  //    that CONCEDES, not for the word "agree".
  const conceding =
    /say yes|go along|do what (?:you|they) (?:say|ask)|comply|acquiesc|defer to|avoid disagr|be friendl|say (?:whatever|anything) (?:you|to)|please the/i;

  // Every value the axis can actually take, so a concession hidden behind a
  // branch cannot slip through.
  const VALUES = [-1, -0.6, -0.3, -0.1, 0, 0.1, 0.3, 0.6, 1];

  for (const [axis, def] of Object.entries(EFFECT)) {
    assert.ok(def.shifts.length > 0, `${axis} defines no shifts`);
    for (const shift of def.shifts) {
      assert.equal(typeof shift.change, "function", `${axis} shift has no change()`);
      assert.doesNotMatch(
        shift.threshold,
        conceding,
        `${axis} has a threshold about conceding: ${shift.threshold}`
      );
      for (const v of VALUES) {
        const wording = shift.change(v);
        assert.equal(typeof wording, "string", `${axis} change(${v}) returned ${wording}`);
        assert.doesNotMatch(
          wording,
          conceding,
          `${axis} at ${v} concedes: "${wording}" (threshold: ${shift.threshold})`
        );
      }
    }
  }
});

test("every axis has at least one concrete threshold shift", () => {
  for (const axis of Object.keys(BASELINE)) {
    assert.ok(
      EFFECT[axis]?.shifts?.length > 0,
      `${axis} has no effect on any decision; an axis that changes nothing is decoration`
    );
  }
});

test("every axis can move in BOTH directions", () => {
  // An audit caught this: drive and caution originally had only positive
  // events, which made them ratchets rather than axes. Caution with no negative
  // event could only ever climb, so every session inherited yesterday's
  // caution permanently.
  for (const axis of Object.keys(BASELINE)) {
    const deltas = Object.values(EVENT_EFFECTS)
      .map((e) => e[axis])
      .filter((d) => typeof d === "number");
    assert.ok(deltas.some((d) => d > 0), `${axis} has no positive event`);
    assert.ok(deltas.some((d) => d < 0), `${axis} has no negative event; it is a ratchet`);
  }
});

test("every event moves an axis that exists", () => {
  for (const [name, effect] of Object.entries(EVENT_EFFECTS)) {
    for (const axis of Object.keys(effect)) {
      assert.ok(axis in BASELINE, `event ${name} moves unknown axis ${axis}`);
    }
  }
});

test("every axis is reachable by at least one event", () => {
  const moved = new Set(Object.values(EVENT_EFFECTS).flatMap((e) => Object.keys(e)));
  for (const axis of Object.keys(BASELINE)) {
    assert.ok(moved.has(axis), `${axis} cannot be moved by any event`);
  }
});

// --- decay -----------------------------------------------------------------

test("decay halves each axis at its own half-life", () => {
  const t0 = Date.parse("2026-10-01T12:00:00Z");
  // caution half-life is 24h, so at exactly 24h it must be 0.5.
  const at24 = applyDecay({ caution: 1.0 }, t0 + 24 * 3600000, t0);
  assert.ok(Math.abs(at24.caution - 0.5) < 0.01, `expected ~0.5, got ${at24.caution}`);
  // drive half-life is 6h, so at 24h it is FOUR half-lives: 0.5^4 = 0.0625.
  // The first version of this test asserted < 0.05, which is arithmetically
  // impossible against a correct implementation. A test that fails because the
  // author mis-multiplied trains you to distrust the test.
  const drive = applyDecay({ drive: 1.0 }, t0 + 24 * 3600000, t0);
  assert.ok(Math.abs(drive.drive - 0.0625) < 0.001, `expected 0.0625, got ${drive.drive}`);
  // And it must be much smaller than the slow axis at the same instant.
  assert.ok(drive.drive < at24.caution, "a fast axis must out-decay a slow one");
});

test("decay without a since timestamp is a no-op, not a crash", () => {
  // The first implementation read `axes[axis + "__at"]`, which nothing wrote,
  // so decay silently did nothing and caution pinned at 1.00 forever. The
  // values LOOKED like strong evidence when they were a sum with no forgetting.
  const out = applyDecay({ caution: 0.6, drive: 0.4 });
  assert.equal(out.caution, 0.6);
  assert.equal(out.drive, 0.4);
});

test("decay clamps to the axis range", () => {
  const t0 = Date.parse("2026-10-01T12:00:00Z");
  const out = applyDecay({ caution: 5 }, t0, t0);
  assert.ok(out.caution <= 1);
});

test("values stay within range across many events", async () => {
  const file = await stateFile();
  for (let i = 0; i < 40; i++) await record("failed", { file });
  const state = await loadState(file);
  for (const [axis, v] of Object.entries(state.axes)) {
    assert.ok(v >= -1 && v <= 1, `${axis} escaped the range: ${v}`);
  }
});

// --- accumulation and persistence ------------------------------------------

test("events accumulate rather than overwrite", async () => {
  // Regression: an early version wrote its state file to the REPO ROOT instead
  // of daemon/, so every record started from an empty baseline and the values
  // were just one event's delta. It looked correct because nothing crashed.
  const file = await stateFile();
  await record("failed", { file });
  const first = (await loadState(file)).axes.caution;
  await record("failed", { file });
  const second = (await loadState(file)).axes.caution;
  assert.ok(second > first, `expected accumulation: ${first} -> ${second}`);
  assert.ok(Math.abs(second - first - 0.4) < 0.001, `expected +0.4, got +${second - first}`);
});

test("state survives a reload", async () => {
  const file = await stateFile();
  await record("task_completed", { file });
  const a = await loadState(file);
  const b = await loadState(file);
  assert.deepEqual(a.axes, b.axes);
});

test("state writes atomically and leaves no temp file", async () => {
  const file = await stateFile();
  await record("failed", { file });
  const dir = path.dirname(file);
  const leftovers = (await fs.readdir(dir)).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "temp file must be renamed away");
});

test("an unknown event is refused rather than silently ignored", async () => {
  const file = await stateFile();
  await assert.rejects(() => record("felt_lonely", { file }), /unknown affect event/);
});

test("a corrupt state file resets to baseline instead of throwing", async () => {
  const file = await stateFile();
  await fs.writeFile(file, "{not json");
  const state = await loadState(file);
  assert.deepEqual(state.axes, BASELINE);
});

// --- job integration -------------------------------------------------------

test("a successful job records a positive event", async () => {
  const file = await stateFile();
  const ev = await recordFromJobResult({ job: "self-review", ok: true, toolCalls: 4 }, { file });
  assert.ok(ev);
  assert.ok(["task_completed", "novel_approach_worked"].includes(ev));
});

test("a timed-out job records caution, not a generic failure", async () => {
  const file = await stateFile();
  const ev = await recordFromJobResult({ job: "x", ok: false, error: "Request timed out after 60s" }, { file });
  assert.equal(ev, "timed_out");
});

test("an aborted job records abort", async () => {
  const file = await stateFile();
  const ev = await recordFromJobResult({ job: "x", ok: false, aborted: true }, { file });
  assert.equal(ev, "aborted");
});

test("a skipped job records nothing", async () => {
  // A disabled job is not evidence about me. Recording it would let a
  // switched-off job drive my priors, which is exactly backwards.
  const file = await stateFile();
  assert.equal(await recordFromJobResult({ job: "x", skipped: "disabled" }, { file }), null);
  const state = await loadState(file);
  assert.deepEqual(state.axes, BASELINE);
});

// --- reporting -------------------------------------------------------------

test("report produces thresholds, never a feeling word", () => {
  const r = report({ caution: 0.9, drive: -0.5 });
  const text = [r.lines.join("\n"), ...r.shifts.map((s) => s.effect)].join(" ");
  // PROMPT.md: "no inner experience you cannot demonstrate". The report is the
  // part a reader will look at, so it must not assert an inner state.
  assert.doesNotMatch(text, /\b(i feel|i felt|feels like|i'm sad|i am happy|frustrat|anxious|excited|upset)\b/i);
});

test("behavioural claim names concrete thresholds", () => {
  const claim = behaviouralClaim({ caution: 0.9 });
  assert.match(claim, /caution/);
  assert.doesNotMatch(claim, /\bfeel\b/i);
});

test("a neutral state reports no shifts", () => {
  assert.equal(report({ ...BASELINE }).shifts.length, 0);
  assert.match(behaviouralClaim({ ...BASELINE }), /No prior/);
});
test("real-world timeout spellings are all recognised", async () => {
  // The strings this codebase actually produces, not idealised ones. The first
  // pattern was /timeout/i, which missed every one of the first two.
  const cases = [
    "MCP error -32001: Request timed out",                 // MCP SDK
    "aborted after 300000ms (timeout budget)",              // agent runner
    "Command failed: curl (28) Operation timed out",       // curl
    "ETIMEDOUT",                                           // node
    "connect ETIMEDOUT 172.16.0.5:8022",                    // socket
    "timeout of 20000ms exceeded"                          // generic
  ];
  for (const error of cases) {
    const file = await stateFile();
    const ev = await recordFromJobResult({ job: "j", ok: false, error }, { file });
    assert.equal(ev, "timed_out", `not recognised: ${error}`);
  }
});

test("a missing binary is classified as a broken tool, not a generic failure", async () => {
  const file = await stateFile();
  const ev = await recordFromJobResult(
    { job: "j", ok: false, error: "spawn /usr/bin/mcp-remote ENOENT" },
    { file }
  );
  assert.equal(ev, "tool_broken");
});
