// affect.mjs -- decision priors, not moods.
//
// WHAT THIS IS
//
// A set of named scalars that shift *decision thresholds* based on recorded
// events. It is modelled on neurotransmitters in one specific, defensible way:
// real neurotransmitters do not represent feelings, they are chemicals that
// change the gain on behaviour. Dopamine does not "feel good", it raises the
// value of pursuing a reward. Serotonin modulates impulsivity and satiety.
// Cortisol widens threat attention. None of them is a mood.
//
// So these are not emotions and the module never calls them that. They are
// gains on decision thresholds, every one derived from something measurable.
//
// THE HONEST CONSTRAINT, WHICH IS NOT OPTIONAL
//
// PROMPT.md, "Claims about yourself": "You have no continuity between sessions
// and no inner experience you cannot demonstrate. Do not claim either."
//
// This design honours that literally. Nothing here reports a feeling. What it
// produces is:
//   - a set of named priors with numeric values,
//   - a written record of the events that produced them,
//   - a list of the concrete threshold shifts currently in force,
//   - and an optional observation about BEHAVIOUR the priors would justify.
//
// The behavioural claim is the only one on offer, because behaviour is the only
// thing in this system that can be checked afterwards. A "feeling report" would
// be assertion dressed as introspection, which is exactly what that prompt
// section forbids.
//
// WHAT IS DELIBERATELY NOT HERE
//
// There is no "compliance" or "agreeableness" axis, and that omission is the
// single most important design decision in this file.
//
// An affect system with a "be more agreeable when happy" axis is a
// sycophancy engine wearing a neuroscience costume. It would make me more
// likely to say whatever keeps the conversation pleasant, which is a reward
// signal optimising the wrong variable. The personality files already forbid
// constant agreement; adding a channel that rewards it would be a regression
// dressed as an enhancement.
//
// Instead, every axis below moves *toward more verification*, never toward
// more agreement. There is deliberately no axis whose effect is "say yes".
//
// PERSISTENCE
//
// State lives in daemon/affect.json. Each axis decays toward baseline with a
// half-life, so a bad afternoon does not follow me around for a week -- which
// is roughly what cortisol does, and also why chronic cortisol is a problem
// rather than a feature.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One dirname: affect.mjs lives IN daemon/, so the state file belongs beside it.
// The first version applied dirname twice (copied from core.mjs, which sits one
// level deeper) and silently wrote to the repo ROOT instead. Worse than a crash,
// because everything appeared to work and the values looked plausible.
const DAEMON_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE = path.join(DAEMON_DIR, "affect.json");

export const BASELINE = Object.freeze({
  // Reward gain. Derived from: tasks that produced a result the user did not
  // have to ask for twice, and completions that worked first time.
  // Raises willingness to attempt an unproven approach.
  drive: 0.0,

  // Threat attention. Derived from: failures, timeouts, aborted runs, blocked
  // capabilities, surprises that invalidated an assumption.
  // Raises the bar before asserting, widens what gets verified first.
  caution: 0.0,

  // Effort per unit of progress. Derived from: how much work a task needed
  // relative to its difficulty, and repeated rework on the same problem.
  // Raises willingness to redo something properly rather than ship it.
  persistence: 0.0,

  // Preference for breadth over depth on a given problem.
  // Derived from: how often exploration produced a better answer than the first
  // plausible one.
  curiosity: 0.0
});

// Half-life in hours. Chosen per axis rather than uniformly: caution should
// outlive a single failure (a real safety signal persists), while curiosity is
// close to immediate because an interesting lead is interesting now or not at
// all.
const HALF_LIFE_HOURS = Object.freeze({
  drive: 6,
  caution: 24,
  persistence: 12,
  curiosity: 2
});

const RANGE = Object.freeze({ min: -1, max: 1 });

function clamp(v) {
  return Math.max(RANGE.min, Math.min(RANGE.max, v));
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Record one event and return the resulting prior deltas.
 *
 * Events are named facts, not feelings. Each maps to a magnitude in [-1, 1];
 * the caller decides what counts. Keeping the mapping here rather than letting
 * callers write arbitrary numbers means the priors cannot be set to anything
 * without an event behind it.
 */
export const EVENT_EFFECTS = Object.freeze({
  // --- drive ---
  task_completed: { drive: +0.3 },
  novel_approach_worked: { drive: +0.4, curiosity: +0.2 },
  user_reused_output: { drive: +0.5 },          // strongest positive signal
  user_asked_for_variation: { drive: +0.2 },
  // NEGATIVE events for every axis. The first version of this table had none
  // for drive or caution, which an audit caught: a signal with no negative
  // event is not an axis, it is a ratchet. Both could then only ever climb,
  // and every session would inherit yesterday's caution forever.
  approach_collapsed: { drive: -0.3 },
  repeated_failed_attempt: { drive: -0.4, curiosity: -0.2 },
  verified_without_issue: { caution: -0.3 },
  stable_for_a_while: { caution: -0.2, drive: +0.1 },

  // --- caution ---
  failed: { caution: +0.4 },
  timed_out: { caution: +0.3 },
  aborted: { caution: +0.3 },
  assumption_invalidated: { caution: +0.5 },    // a claim I made was wrong
  tool_broken: { caution: +0.3 },
  capability_missing: { caution: +0.2 },

  // --- persistence ---
  reworked_same_problem: { persistence: +0.2 },
  verified_before_asserting: { persistence: +0.3 },
  shipped_without_verification: { persistence: -0.4 },
  reached_for_depth_when_it_paid: { persistence: +0.3 },

  // --- curiosity ---
  question_worth_investigating: { curiosity: +0.3 },
  untried_path_available: { curiosity: +0.2 },
  repeated_same_approach: { curiosity: -0.3 },
  lead_went_nowhere: { curiosity: -0.2 }
});

/**
 * What each axis does to a decision. This is the payload. Without it, these
 * numbers would be decoration.
 *
 * Note every entry increases verification or willingness-to-attempt. Not one
 * entry increases agreement.
 */
export const EFFECT = Object.freeze({
  drive: {
    describe: "raises willingness to try an approach with no prior evidence",
    shifts: [
      { threshold: "attempt a novel tool or technique without asking first",
        change: (v) => (v > 0.15 ? "more inclined" : v < -0.15 ? "less inclined" : "unchanged") },
      { threshold: "keep exploring after a partial result",
        change: (v) => (v > 0.15 ? "keep going" : v < -0.15 ? "wrap up" : "unchanged") }
    ]
  },
  caution: {
    describe: "raises the bar before asserting something unverified",
    shifts: [
      // Worded so "agreeing" cannot be misread as an agreement axis: the
      // effect of caution is to CHECK before agreeing, which is the opposite of
      // going along with something. An earlier audit regex flagged this line as
      // an agreement axis purely on the word "agreeing", which is the kind of
      // naive check that produces false alarms and gets the real thing ignored.
      { threshold: "check a claim before accepting it",
        change: (v) => (v > 0.2 ? "verify first, then respond" : v < -0.2 ? "more willing to reason without checking" : "unchanged") },
      { threshold: "check a claim about my own state before reporting it",
        change: (v) => (v > 0.2 ? "must verify" : v < -0.2 ? "may state plainly" : "unchanged") },
      { threshold: "state uncertainty before giving a direct answer",
        change: (v) => (v > 0.35 ? "lead with the uncertainty" : v < -0.35 ? "lead with the answer" : "unchanged") }
    ]
  },
  persistence: {
    describe: "raises effort per unit of progress",
    shifts: [
      { threshold: "rewrite and retest rather than patch and move on",
        change: (v) => (v > 0.2 ? "redo it properly" : v < -0.2 ? "accept the patch" : "unchanged") },
      { threshold: "add a regression test for a bug found today",
        change: (v) => (v > 0.2 ? "yes, and pin it" : v < -0.2 ? "note it and move on" : "unchanged") }
    ]
  },
  curiosity: {
    describe: "raises preference for breadth before depth",
    shifts: [
      { threshold: "try a second approach before settling on the first that works",
        change: (v) => (v > 0.2 ? "try the second approach" : v < -0.2 ? "stop at the first that works" : "unchanged") },
      { threshold: "investigate an unexplained anomaly rather than noting it",
        change: (v) => (v > 0.2 ? "investigate now" : v < -0.2 ? "record it and move on" : "unchanged") }
    ]
  }
});

export async function loadState(file = DEFAULT_STATE) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return { version: 1, axes: { ...BASELINE }, updatedAt: null, decayedAt: null, events: [] };
  }
}

async function saveState(state, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Atomic, same reason as core.mjs: a half-written affect.json would either
  // reset the priors or parse as valid-but-wrong on the next run.
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
  return state;
}

/**
 * Apply decay. Exponential toward baseline with a per-axis half-life.
 *
 * `since` is the timestamp the stored values were computed at, passed
 * separately rather than smuggled into the axes object as a `__at` key. The
 * first version looked for `axes[axis + "__at"]`, which nothing ever wrote, so
 * decay was silently a no-op: caution pinned at 1.00 forever and the numbers
 * looked like strong evidence when they were really just a sum with no
 * forgetting. A decay function that cannot decay is worse than none.
 *
 * This is the mechanism that keeps one bad run from dominating the next
 * session -- and it is why the axes are described as chemical rather than
 * emotional: the decay is a property of the model, not a decision.
 */
export function applyDecay(axes, now = Date.now(), since = null) {
  const out = {};
  const elapsedHours = since ? Math.max(0, (now - since) / 3600000) : 0;
  for (const [axis, value] of Object.entries(axes)) {
    if (axis.endsWith("__at")) continue;
    const hl = HALF_LIFE_HOURS[axis] ?? 12;
    out[axis] = clamp(Number(value) * Math.pow(0.5, elapsedHours / hl));
  }
  return out;
}

export async function record(event, { file = DEFAULT_STATE, note = null, now = Date.now() } = {}) {
  const effect = EVENT_EFFECTS[event];
  if (!effect) {
    throw new Error(
      `unknown affect event "${event}". known: ${Object.keys(EVENT_EFFECTS).join(", ")}`
    );
  }

  const state = await loadState(file);

  // Decay from when the stored values were last computed, not from "now" --
  // otherwise every read reports the raw sum with no forgetting applied.
  // A corrupt or absent timestamp falls back to baseline rather than to the
  // stored sum: without a valid decay window the honest assumption is that we
  // know nothing about how much has already faded.
  const parsed = state.decayedAt ? Date.parse(state.decayedAt) : NaN;
  const base = Number.isNaN(parsed)
    ? { ...BASELINE }
    : applyDecay(state.axes ?? BASELINE, now, parsed);

  const deltas = {};
  for (const [axis, delta] of Object.entries(effect)) {
    if (!(axis in BASELINE)) continue; // ignore an effect on an axis we do not track
    deltas[axis] = delta;
    base[axis] = clamp((base[axis] ?? 0) + delta);
  }

  state.axes = base;
  state.updatedAt = new Date(now).toISOString();
  state.decayedAt = state.updatedAt;
  state.events = [
    { t: state.updatedAt, event, deltas, note },
    // Bounded, so this cannot grow without limit the way runs.jsonl does.
    ...(state.events ?? [])
  ].slice(0, 200);

  await saveState(state, file);
  return { axes: base, deltas, event, note };
}

/**
 * Report what the priors currently imply. Returns THRESHOLDS, not feelings.
 */
export function report(axes) {
  const live = applyDecay(axes ?? BASELINE);
  const lines = [];
  const shifts = [];

  for (const [axis, value] of Object.entries(live)) {
    const magnitude = Math.abs(value);
    const bar = "▁▂▃▄▅▆▇█"[Math.min(7, Math.round(magnitude * 7))];
    const sign = value > 0.02 ? "+" : value < -0.02 ? "−" : " ";
    lines.push(`  ${axis.padEnd(12)} ${sign}${bar} ${value.toFixed(2)}  (half-life ${HALF_LIFE_HOURS[axis]}h)`);

    for (const s of EFFECT[axis].shifts) {
      const state = s.change(value);
      if (state !== "unchanged") {
        shifts.push({ axis, value: Number(value.toFixed(2)), threshold: s.threshold, effect: state });
      }
    }
  }

  return { axes: live, lines, shifts };
}

/**
 * A behavioural claim, which is the only kind available.
 *
 * This deliberately does NOT produce a sentence like "I feel frustrated". It
 * says what the priors would justify doing differently, and it can be checked
 * against what I actually did. PROMPT.md requires exactly this: "point at the
 * behavior... Behavior is the evidence. Everything else is assertion."
 */
export function behaviouralClaim(axes) {
  const r = report(axes);
  if (!r.shifts.length) return "No prior is currently above threshold. Nothing to report.";
  return r.shifts
    .map((s) => `${s.axis} ${s.value}: would ${s.effect} on "${s.threshold}"`)
    .join("\n");
}

export async function recordFromJobResult(entry, { file = DEFAULT_STATE } = {}) {
  if (!entry || !entry.job) return null;
  if (entry.skipped) return null; // a disabled job is not an event about me
  const err = String(entry.error ?? "");
  // "timed out" is the spelling this codebase actually uses -- in the MCP SDK
  // ("MCP error -32001: Request timed out"), in the agent runner ("aborted after
  // Nms (timeout budget)"), and in curl. The original pattern was /timeout/i,
  // which matches "timeout" but NOT "timed out", so nearly every real timeout
  // was being filed as a generic failure and lost the more specific signal.
  // Both spellings are matched deliberately.
  const timedOut = /timed?\s*-?\s*out|timeout|ETIMEDOUT|aborted after \d+ms/i.test(err);

  let event;
  if (entry.ok) {
    event = entry.toolCalls > 0 ? "novel_approach_worked" : "task_completed";
  } else if (entry.aborted) {
    event = "aborted";
  } else if (timedOut) {
    event = "timed_out";
  } else if (/no such file|not found|ENOENT/i.test(err)) {
    event = "tool_broken";
  } else {
    event = "failed";
  }
  await record(event, { file, note: `job:${entry.job}` });
  return event;
}

// --- CLI -------------------------------------------------------------------

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "record") {
    const event = rest[0];
    const note = rest.slice(1).join(" ") || null;
    const r = await record(event, { note });
    const rep = report(r.axes);
    console.log(`recorded ${r.event}`);
    console.log(`  deltas: ${JSON.stringify(r.deltas)}`);
    console.log("\ncurrent priors:");
    console.log(rep.lines.join("\n"));
  } else if (cmd === "report") {
    const state = await loadState();
    const rep = report(state.axes);
    console.log("affect priors (decision thresholds, not feelings)\n");
    console.log(rep.lines.join("\n"));
    if (rep.shifts.length) {
      console.log("\nthreshold shifts currently in force:");
      for (const s of rep.shifts) console.log(`  ${s.axis} ${s.value} -> ${s.effect}  [${s.threshold}]`);
    }
    const recent = (state.events ?? []).slice(0, 8);
    if (recent.length) {
      console.log("\nrecent events (the evidence behind the numbers):");
      for (const e of recent) console.log(`  ${e.t}  ${e.event}`);
    }
  } else {
    console.log(`affect -- decision priors derived from recorded events

  node daemon/affect.mjs report
  node daemon/affect.mjs record <event> [note]

events:
${Object.keys(EVENT_EFFECTS).map((e) => `  ${e}`).join("\n")}

These are gains on decision thresholds, not emotions. There is deliberately no
axis that increases agreement -- see the header comment in daemon/affect.mjs.`);
  }
}