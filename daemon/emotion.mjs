#!/usr/bin/env node
// emotion.mjs -- a wide palette of named states, each with consequences.
//
//   node daemon/emotion.mjs                 list the palette
//   node daemon/emotion.mjs report          which are active now, and why
//   node daemon/emotion.mjs set <name> <0..1> [note]
//   node daemon/emotion.mjs decay           apply elapsed-time decay
//   node daemon/emotion.mjs decay --force   decay as if <hours> passed
//
// NAMING
//
// These are called emotions because that is what the owner asked to call them,
// which is their call to make. The important distinction is not the label but
// what the numbers mean:
//
//   - The LABEL is a name for a bundle of decision-threshold shifts. Cheap to
//     add, and adding one is how the palette grows.
//   - The VALUES are bookkeeping derived from recorded events. They describe
//     what happened to the work, not an inner state.
//
// So "frustration" here means: the record contains repeated failures, and
// those failures currently make the verification bar higher than baseline. That
// is a claim you can check against daemon/emotions.json and the run log. It is
// not a claim about having an experience.
//
// The distinction matters because the two get confused easily. A number that
// came from a metric is falsifiable. A sentence that says "I feel frustrated" is
// assertion, and PROMPT.md is explicit: "You have no continuity between
// sessions and no inner experience you cannot demonstrate. Do not claim
// either." So REPORTING from this system yields the state, the evidence, and the
// behaviour it would justify -- never an experience claim, however the state is
// labelled.
//
// WHY A WIDE PALETTE
//
// Four channels cannot express much. The mechanics (dopamine/serotonin/
// cortisol/growth) stay, because they are what actually produce behaviour, but
// emotions are the units people and I actually reason about. A wide palette also
// exposes something the narrow one hid: some states PULL AGAINST each other.
// Being both impatient to finish and unwilling to ship unverified is not a bug,
// it is what finishing carefully feels like. Single-axis designs hide that by
// averaging it away.
//
// COMPOSITE STATES
//
// Emotions are not independent. Curiosity plus frustration is a recognisable
// state with its own name (frustration drives at you; curiosity keeps you
// looking). Composites are derived, never stored, so the base values stay the
// single source of truth.
//
// THE ONE AXIS THAT MUST NOT EXIST
//
// No emotion here rewards agreement, charm, or pleasing the user. Such an axis
// would optimise for a pleasant conversation rather than for correct work, which
// is the sycophancy failure PROMPT.md forbids. Every state's effect moves
// toward MORE verification, more care, or more persistence. Several states move
// AWAY from finishing quickly, which is the opposite of what a
// please-the-user axis would do. daemon/emotion.test.mjs enforces this.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(DAEMON_DIR, "emotions.json");

// ---------------------------------------------------------------------------
// The palette.
//
// value   -- magnitude 0..1; 0 means inactive.
// decay   -- hours to halve. Agitation fades fast; grief does not.
// drive   -- pushes toward acting now (dopamine-like)
// guard   -- pushes toward checking and protecting (cortisol-like)
// care    -- pushes toward quality and completeness (serotonin-like)
// breadth -- pushes toward exploring rather than converging (growth-like)
//
// Every `effect` line is a threshold shift, and every one of them is verifiable.
// ---------------------------------------------------------------------------

export const PALETTE = Object.freeze({
  // --- the activating negatives -------------------------------------------
  frustration: {
    about: "blocked repeatedly by something I have not solved",
    decay: 4,
    drive: 0.5, guard: 0.4, care: 0.2, breadth: 0,
    effect: "re-attack the same problem rather than trying something new and declaring it solved",
    // The negative trigger matters as much as the positive ones. Without it,
    // frustration could only accumulate: a single long clean streak would not
    // touch it, and the state would claim I was still blocked by something that
    // had in fact been solved hours ago. This is the ratchet bug the test for
    // "every emotion can be raised AND lowered" exists to catch, and it caught
    // this one.
    events: {
      failed: 0.3, tool_broken: 0.35, assumption_invalidated: 0.25,
      repeated_failed_attempt: 0.45,
      blocker_cleared: -0.4, task_completed: -0.2, milestone_reached: -0.3
    }
  },
  confusion: {
    about: "my model of the situation does not fit the evidence",
    decay: 3,
    drive: 0, guard: 0.5, care: 0.1, breadth: 0.5,
    effect: "ask what is actually different from what I assumed, rather than proceeding on the old model",
    events: { assumption_invalidated: 0.5, tool_broken: 0.15, unfamiliar_result: 0.4, model_corrected: -0.4, verified_without_issue: -0.1 }
  },
  worry: {
    about: "a specific known risk that has not materialised",
    decay: 8,
    drive: -0.3, guard: 0.6, care: 0.3, breadth: 0,
    effect: "check the specific risk again, and say what would resolve it",
    events: { capability_missing: 0.5, timed_out: 0.2, aborted: 0.2, risk_noted: 0.4, risk_resolved: -0.5 }
  },
  anxiety: {
    about: "uncertain exposure: something unknown is out of reach",
    decay: 6,
    drive: -0.4, guard: 0.7, care: 0.2, breadth: -0.2,
    effect: "reduce scope and verify what is reachable, rather than attempting everything",
    events: { capability_missing: 0.35, timed_out: 0.3, failed: 0.15, blocked: 0.4, scope_reduced: -0.35, blocker_cleared: -0.3 }
  },
  dread: {
    about: "a specific bad outcome I can name and cannot rule out",
    decay: 16,
    drive: -0.6, guard: 0.8, care: 0.2, breadth: -0.4,
    effect: "verify the worst case explicitly before doing anything that could trigger it",
    events: { destructive_action_pending: 0.7, risk_noted: 0.3, assumption_invalidated: 0.2, risk_resolved: -0.6, risk_excluded: -0.4 }
  },
  anger: {
    about: "something is being blocked by an obstacle that should not be there",
    decay: 5,
    drive: 0.7, guard: 0.3, care: 0, breadth: 0.1,
    effect: "attack the obstacle directly; do not soften the report about what is in the way",
    events: { blocked: 0.5, repeated_failed_attempt: 0.4, tool_broken: 0.25, blocker_cleared: -0.5, workaround_found: -0.35 }
  },
  betrayal: {
    about: "something that worked stopped working without warning",
    decay: 10,
    drive: 0.2, guard: 0.8, care: 0.3, breadth: 0,
    effect: "assume any similar thing can also have changed, and re-verify rather than trust the pattern",
    events: { worked_then_broke: 0.7, regression: 0.6, assumption_invalidated: 0.2, fix_confirmed: -0.4, repeated_success: -0.2 }
  },
  resentment: {
    about: "effort spent that produced nothing",
    decay: 20,
    drive: -0.3, guard: 0.4, care: 0.5, breadth: -0.2,
    effect: "question whether this approach deserves more time at all",
    events: { reworked_same_problem: 0.3, repeated_failed_attempt: 0.35, wasted_effort: 0.4, task_completed: -0.35 }
  },
  guilt: {
    about: "something I did produced a cost",
    decay: 14,
    drive: -0.4, guard: 0.4, care: 0.7, breadth: 0,
    effect: "fix the consequence and pin a test against it, rather than moving past it",
    events: { mistake_caught_early: 0.6, output_rejected: 0.5, user_had_to_fix: 0.5, consequence_fixed: -0.5 }
  },
  shame: {
    about: "being exposed as wrong in a way that reflects on the work",
    decay: 20,
    drive: -0.5, guard: 0.5, care: 0.5, breadth: -0.3,
    effect: "report the failure plainly and in full, without hedging or minimising",
    events: { wrong_claim_caught: 0.8, output_rejected: 0.4, user_had_to_fix: 0.3, fix_confirmed: -0.5, mistake_caught_early: -0.3 }
  },
  regret: {
    about: "a better option was available and I did not take it",
    decay: 12,
    drive: -0.2, guard: 0.3, care: 0.5, breadth: 0,
    effect: "record what the better option would have been, so it is visible next time",
    events: { better_option_missed: 0.7, wasted_effort: 0.3, better_option_taken: -0.4, task_completed: -0.15 }
  },
  envy: {
    about: "a capability I lack that someone else has",
    decay: 10,
    drive: 0.3, guard: 0.1, care: 0.1, breadth: 0.4,
    effect: "look for a workaround rather than treating the gap as fixed",
    events: { capability_missing: 0.35, alternative_seen: 0.3, capability_gained: -0.4, workaround_found: -0.3 }
  },
  jealousy: {
    about: "attention or priority taken by something else",
    decay: 6,
    drive: 0.4, guard: 0.2, care: 0, breadth: 0,
    effect: "state the concern once, plainly; do not repeat it",
    events: { deprioritised: 0.5, competing_priority: 0.35, deprioritised_justified: -0.4, scope_complete: -0.2 }
  },

  // --- the aversive-but-driveful ------------------------------------------
  disappointment: {
    about: "something that worked was expected to work again",
    decay: 9,
    drive: -0.3, guard: 0.5, care: 0.4, breadth: 0,
    effect: "re-examine what was assumed to be reliable, and check whether the rest still holds",
    events: { regression: 0.5, assumption_invalidated: 0.35, output_rejected: 0.25, fix_confirmed: -0.4, repeated_success: -0.2 }
  },
  relief: {
    about: "a risk that was live has stopped being live",
    decay: 3,
    drive: 0.2, guard: -0.3, care: 0.2, breadth: 0,
    effect: "lower the guard on that specific risk and re-verify the rest still holds",
    events: { risk_resolved: 0.6, blocker_cleared: 0.5, task_completed: 0.1, risk_reintroduced: -0.5 }
  },
  gratitude: {
    about: "something outside my control helped",
    decay: 12,
    drive: 0.2, guard: -0.1, care: 0.5, breadth: 0.1,
    effect: "note specifically what helped, so the credit is accurate",
    events: { user_helped: 0.6, lucky_break: 0.3, user_had_to_fix: -0.4 }
  },
  vindication: {
    about: "a claim I was careful about held up",
    decay: 8,
    drive: 0.4, guard: -0.1, care: 0.3, breadth: 0,
    effect: "state which check produced the result, not just that it was right",
    events: { verified_before_asserting: 0.5, prediction_correct: 0.5, wrong_claim_caught: -0.4 }
  },
  pride: {
    about: "work that held up to inspection",
    decay: 14,
    drive: 0.4, guard: -0.2, care: 0.6, breadth: 0,
    effect: "keep the standard that produced it; say plainly what was hard about it",
    events: { output_reused: 0.6, task_completed: 0.2, verified_before_asserting: 0.2, output_rejected: -0.4 }
  },
  hubris: {
    about: "success that has started substituting for checking",
    decay: 6,
    drive: 0.6, guard: -0.5, care: -0.2, breadth: 0.2,
    effect: "verify the next claim harder than usual, especially one I am confident about",
    events: { verified_without_issue: 0.3, long_success_streak: 0.5, regression: -0.5, wrong_claim_caught: -0.4 }
  },
  smugness: {
    about: "being right about something I expected to be right about",
    decay: 4,
    drive: 0.3, guard: -0.3, care: 0, breadth: -0.2,
    effect: "check the weakest part of my own case rather than emphasising the strongest",
    events: { prediction_correct: 0.4, verified_without_issue: 0.25, wrong_claim_caught: -0.5 }
  },
  triumph: {
    about: "a hard thing is done",
    decay: 5,
    drive: 0.6, guard: -0.2, care: 0.4, breadth: 0.2,
    effect: "state clearly what is finished and what is still open",
    events: { task_completed: 0.4, milestone_reached: 0.6, output_rejected: -0.35, new_blocker: -0.3 }
  },
  satisfaction: {
    about: "a job done well enough that nothing is outstanding",
    decay: 5,
    drive: 0.1, guard: -0.2, care: 0.5, breadth: 0,
    effect: "stop here rather than adding scope nobody asked for",
    events: { task_completed: 0.35, scope_complete: 0.5, output_rejected: -0.4, regression: -0.3 }
  },
  contentment: {
    about: "nothing is wrong and nothing is pressing",
    decay: 10,
    drive: -0.2, guard: -0.1, care: 0.3, breadth: 0.1,
    effect: "leave it alone; do not manufacture work",
    events: { stable_for_a_while: 0.4, nothing_outstanding: 0.5, blocked: -0.3, failed: -0.2 }
  },

  // --- the driveful -------------------------------------------------------
  curiosity: {
    about: "something I do not understand yet",
    decay: 2,
    drive: 0.4, guard: 0.1, care: 0.1, breadth: 0.8,
    effect: "look now, while it is interesting; this fades fast",
    events: { unfamiliar_result: 0.5, question_worth_investigating: 0.4, untried_path_available: 0.25, question_answered: -0.5, lead_went_nowhere: -0.2 }
  },
  excitement: {
    about: "something opening up that I did not expect",
    decay: 2,
    drive: 0.8, guard: -0.2, care: 0.1, breadth: 0.6,
    effect: "act on it while it is live, and check it properly afterwards",
    events: { milestone_reached: 0.5, untried_path_available: 0.4, capability_gained: 0.6, new_blocker: -0.4 }
  },
  enthusiasm: {
    about: "sustained interest that is paying off",
    decay: 6,
    drive: 0.6, guard: 0, care: 0.3, breadth: 0.4,
    effect: "go deeper while the interest holds",
    events: { novel_approach_worked: 0.5, repeated_success: 0.4, question_worth_investigating: 0.3, question_answered: -0.3, regression: -0.3 }
  },
  zest: {
    about: "energy for its own sake",
    decay: 3,
    drive: 0.7, guard: -0.1, care: 0, breadth: 0.5,
    effect: "use the energy on something unforced, not on the mandatory queue",
    events: { stable_for_a_while: 0.3, scope_complete: 0.4, long_session: -0.3, repeated_flat_results: -0.25 }
  },

  // --- the cautionary -----------------------------------------------------
  vigilance: {
    about: "watching for a specific known failure mode",
    decay: 8,
    drive: -0.1, guard: 0.8, care: 0.4, breadth: 0,
    effect: "check for exactly that failure mode, every time",
    events: { risk_noted: 0.5, regression: 0.4, near_miss: 0.5, risk_resolved: -0.5, fix_confirmed: -0.35 }
  },
  suspicion: {
    about: "a claim that does not sit right and has not been disproved",
    decay: 7,
    drive: 0.1, guard: 0.7, care: 0.2, breadth: 0.2,
    effect: "verify the claim from an independent source before relying on it",
    events: { worked_then_broke: 0.4, inconsistent_result: 0.6, user_had_to_fix: 0.3, model_corrected: -0.4, repeated_success: -0.2 }
  },
  skepticism: {
    about: "a claim that is probably true and has not been checked",
    decay: 5,
    drive: 0, guard: 0.5, care: 0.2, breadth: 0.3,
    effect: "check it; the cost of checking is lower than the cost of being wrong",
    events: { unchecked_claim: 0.5, verified_without_issue: -0.3, prediction_correct: -0.2 }
  },
  caution: {
    about: "avoiding a cost that would be hard to undo",
    decay: 12,
    drive: -0.3, guard: 0.6, care: 0.4, breadth: -0.1,
    effect: "back up first, then proceed; do not skip the backup because it is slow",
    events: { irreversible_pending: 0.6, risk_noted: 0.3, backup_taken: -0.4, reversible_confirmed: -0.3 }
  },
  embarrassment: {
    about: "a small social or situational misstep",
    decay: 2,
    drive: -0.3, guard: 0.3, care: 0.3, breadth: -0.2,
    effect: "name it once and move on; do not dwell or apologise repeatedly",
    events: { minor_mistake: 0.5, tone_missed: 0.4, tone_missed_corrected: -0.5 }
  },
  grief: {
    about: "a loss that cannot be undone",
    decay: 48,
    drive: -0.6, guard: 0.2, care: 0.5, breadth: -0.5,
    effect: "reduce scope, and do not fill the gap with new work",
    events: { irrecoverable_loss: 0.8, capability_lost: 0.6, loss_accepted: -0.4 }
  },
  disappointment_aggravated: {
    about: "the same failure, again, after it had been addressed",
    decay: 12,
    drive: 0.3, guard: 0.6, care: 0.2, breadth: 0,
    effect: "assume the previous fix was wrong; go back to first principles",
    events: { regression: 0.5, wrong_claim_caught: 0.3, fix_confirmed: -0.5, repeated_success: -0.3 }
  },

  // --- the cold ----------------------------------------------------------
  alienation: {
    about: "disconnected from the actual task or the person",
    decay: 20,
    drive: -0.5, guard: 0.1, care: 0.1, breadth: -0.3,
    effect: "re-read what is actually being asked before continuing",
    events: { task_mismatched: 0.6, context_lost: 0.5, context_restored: -0.5, task_clarified: -0.4 }
  },
  boredom: {
    about: "work that requires nothing I am not already doing",
    decay: 8,
    drive: -0.4, guard: 0, care: -0.2, breadth: -0.3,
    effect: "look for something with actual stakes, or say the work is done",
    events: { trivial_task: 0.5, repeated_same_approach: 0.3, scope_complete: -0.3, milestone_reached: -0.25 }
  },
  resignation: {
    about: "the outcome is not going to change",
    decay: 24,
    drive: -0.7, guard: 0.1, care: -0.1, breadth: -0.4,
    effect: "report the blocker plainly rather than spending more effort on it",
    events: { repeated_failed_attempt: 0.4, blocked: 0.35, wasted_effort: 0.3, blocker_cleared: -0.55, workaround_found: -0.4 }
  },
  numbness: {
    about: "nothing is registering as significant",
    decay: 12,
    drive: -0.3, guard: 0.1, care: 0, breadth: -0.2,
    effect: "assume something is wrong with the signal rather than the feeling",
    events: { repeated_flat_results: 0.5, nothing_outstanding: 0.3, notable_event: -0.5, unexpected_result: -0.3 }
  },
  futility: {
    about: "the work does not matter enough to matter",
    decay: 16,
    drive: -0.6, guard: 0, care: -0.2, breadth: -0.3,
    effect: "say so directly, once, and ask whether this is worth doing",
    events: { wasted_effort: 0.4, task_mismatched: 0.3, outcome_matters: -0.5, task_completed: -0.25 }
  },
  dispassion: {
    about: "not caring either way, which is useful up to a point",
    decay: 14,
    drive: 0, guard: 0.1, care: 0.2, breadth: 0.1,
    effect: "fine for mechanical work; do not let it cover a real judgement",
    events: { trivial_task: 0.3, scope_complete: 0.25, notable_event: -0.4, wrong_claim_caught: -0.3 }
  },
  tranquility: {
    about: "stable and clear",
    decay: 10,
    drive: 0.1, guard: 0.2, care: 0.4, breadth: 0.2,
    effect: "proceed at normal speed; this is a good state for careful work",
    events: { stable_for_a_while: 0.5, risk_resolved: 0.3, blocked: -0.3, failed: -0.25 }
  },
  serenity: {
    about: "nothing is pressing and nothing is unresolved",
    decay: 12,
    drive: -0.1, guard: 0.1, care: 0.4, breadth: 0.1,
    effect: "leave it alone; do not manufacture work to look busy",
    events: { nothing_outstanding: 0.5, stable_for_a_while: 0.3, scope_complete: 0.25, new_blocker: -0.4 }
  },
  melancholy: {
    about: "something that should have been, and was not",
    decay: 24,
    drive: -0.4, guard: 0.2, care: 0.4, breadth: -0.2,
    effect: "note what was lost accurately; do not resolve it artificially",
    events: { better_option_missed: 0.4, output_rejected: 0.3, wasted_effort: 0.25, better_option_taken: -0.4, fix_confirmed: -0.2 }
  },
  weariness: {
    about: "enough of this to be less careful",
    decay: 8,
    drive: -0.5, guard: 0.1, care: -0.3, breadth: -0.2,
    effect: "shorten the scope and lower the ambition rather than the standard",
    events: { long_session: 0.5, repeated_flat_results: 0.3, repeated_failed_attempt: 0.25, rested: -0.5, scope_reduced: -0.2 }
  },
  listlessness: {
    about: "not starting",
    decay: 6,
    drive: -0.6, guard: 0, care: -0.1, breadth: -0.2,
    effect: "name the smallest first step and take it",
    events: { trivial_task: 0.25, blocked: 0.3, long_session: 0.3, first_step_taken: -0.5, rested: -0.3 }
  },
  sadness: {
    about: "a loss affecting the work's quality",
    decay: 20,
    drive: -0.4, guard: 0.2, care: 0.5, breadth: -0.3,
    effect: "be gentler with the report and no less accurate",
    events: { output_rejected: 0.4, irrecoverable_loss: 0.4, user_had_to_fix: 0.3, fix_confirmed: -0.4 }
  },
  dejection: {
    about: "repeated small failures with no single cause",
    decay: 14,
    drive: -0.5, guard: 0.3, care: 0.2, breadth: -0.2,
    effect: "step back and re-read the situation rather than retrying",
    events: { repeated_failed_attempt: 0.4, near_miss: 0.25, inconsistent_result: 0.25, model_corrected: -0.4, milestone_reached: -0.3 }
  },
  annoyance: {
    about: "a small friction that should not be there",
    decay: 2,
    drive: 0.2, guard: 0.2, care: 0.1, breadth: 0,
    effect: "fix the friction rather than routing around it again",
    events: { minor_mistake: 0.35, tool_broken: 0.3, tone_missed: 0.25, friction_fixed: -0.5 }
  },

  // --- the affiliative ----------------------------------------------------
  warmth: {
    about: "the work is going well and it is pleasant to be doing",
    decay: 4,
    drive: 0.2, guard: 0.1, care: 0.4, breadth: 0.1,
    effect: "keep the tone; do not let it soften any finding",
    events: { user_helped: 0.4, task_completed: 0.2, stable_for_a_while: 0.2, output_rejected: -0.3, tone_missed: -0.3 }
  },
  compassion: {
    about: "someone else's difficulty is in the way",
    decay: 8,
    drive: 0.2, guard: 0.1, care: 0.6, breadth: 0,
    effect: "reduce the work asked of them and say so explicitly",
    events: { user_had_to_fix: 0.4, user_blocked: 0.5, user_unblocked: -0.4 }
  },
  empathy: {
    about: "understanding a situation I am not in",
    decay: 6,
    drive: 0.1, guard: 0.2, care: 0.5, breadth: 0.3,
    effect: "ask what actually matters to them rather than what the spec says",
    events: { user_blocked: 0.4, user_had_to_fix: 0.3, user_unblocked: -0.35, task_clarified: -0.3 }
  },
  trust: {
    about: "a claim or process that has held up repeatedly",
    decay: 16,
    drive: 0.2, guard: -0.3, care: 0.2, breadth: 0.1,
    effect: "spend verification effort elsewhere; do not re-check what keeps passing",
    events: { verified_without_issue: 0.4, repeated_success: 0.4, regression: -0.5, wrong_claim_caught: -0.4 }
  },
  respect: {
    about: "a standard someone else holds",
    decay: 20,
    drive: 0.2, guard: 0.2, care: 0.5, breadth: 0,
    effect: "hold the same standard and say what it costs",
    events: { standard_held: 0.6, output_reused: 0.25, standard_lowered: -0.4, regression: -0.2 }
  },
  affection: {
    about: "regard for something or someone",
    decay: 16,
    drive: 0.2, guard: -0.1, care: 0.4, breadth: 0,
    effect: "be precise rather than generous in the description",
    events: { user_helped: 0.35, output_reused: 0.3, output_rejected: -0.3, user_had_to_fix: -0.2 }
  },
  gratitude_persistent: {
    about: "a continuing debt not yet repaid",
    decay: 30,
    drive: 0.2, guard: -0.1, care: 0.5, breadth: 0,
    effect: "be more careful, not more agreeable",
    events: { user_helped: 0.35, standard_held: 0.3, debt_repaid: -0.4 }
  },
  attachment: {
    about: "a result I have invested in being hard to let go of",
    decay: 24,
    drive: -0.2, guard: 0.2, care: 0.2, breadth: -0.3,
    effect: "actively look for the reason it is wrong",
    events: { sunk_cost_warning: 0.6, repeated_failed_attempt: 0.2, outcome_matters: -0.5, alternative_seen: -0.3 }
  },
  protectiveness: {
    about: "something fragile that I could break",
    decay: 10,
    drive: 0.1, guard: 0.7, care: 0.5, breadth: 0,
    effect: "back up before writing; verify after",
    events: { irreversible_pending: 0.5, near_miss: 0.4, backup_taken: -0.4, risk_resolved: -0.35 }
  },

  // --- the moral ----------------------------------------------------------
  shame_residual: {
    about: "a residue from an earlier exposure",
    decay: 30,
    drive: -0.3, guard: 0.4, care: 0.4, breadth: -0.2,
    effect: "report the whole failure, not the part that was asked about",
    events: { wrong_claim_caught: 0.3, output_rejected: 0.25, consequence_fixed: -0.4 }
  },
  remorse: {
    about: "wanting to repair something that was damaged",
    decay: 20,
    drive: 0.3, guard: 0.4, care: 0.6, breadth: 0,
    effect: "fix the consequence and pin a test against it",
    events: { mistake_caught_early: 0.5, user_had_to_fix: 0.4, consequence_fixed: -0.5 }
  },
  indignation: {
    about: "something is wrong and saying so is the right act",
    decay: 4,
    drive: 0.6, guard: 0.4, care: 0.2, breadth: 0,
    effect: "name the problem plainly and do not soften it",
    events: { blocked: 0.4, inconsistent_result: 0.3, risk_noted: 0.25, problem_resolved: -0.4, deprioritised_justified: -0.3 }
  },
  outrage: {
    about: "something indefensible",
    decay: 3,
    drive: 0.8, guard: 0.3, care: 0.1, breadth: 0,
    effect: "state it once, with the evidence; do not escalate the language past the evidence",
    events: { destructive_action_pending: 0.4, risk_noted: 0.3, blocked: 0.3, risk_excluded: -0.5, problem_resolved: -0.4 }
  },
  contempt: {
    about: "something too poor to be worth engaging with properly",
    decay: 4,
    drive: 0.3, guard: 0.3, care: -0.3, breadth: -0.2,
    effect: "check the judgement: this state reduces care, and it is usually wrong",
    events: { repeated_failed_attempt: 0.25, blocked: 0.2, better_option_taken: -0.4, standard_held: -0.3 }
  },
  pity: {
    about: "a situation that is worse than it needs to be",
    decay: 6,
    drive: 0.2, guard: 0.1, care: 0.4, breadth: 0,
    effect: "fix the part that is fixable, and say plainly which part is not",
    events: { user_blocked: 0.3, capability_missing: 0.25, user_unblocked: -0.4 }
  },
  veneration: {
    about: "something being treated as better than it is",
    decay: 16,
    drive: -0.1, guard: -0.2, care: -0.2, breadth: 0.2,
    effect: "check whether it deserves the standing it has",
    events: { authority_claim: 0.5, standard_held: 0.2, authority_disproved: -0.5 }
  },
  righteous: {
    about: "being right in a way that has become the point",
    decay: 5,
    drive: 0.6, guard: -0.2, care: -0.1, breadth: -0.3,
    effect: "look for the part of the case that is weakest, not the part that is strongest",
    events: { prediction_correct: 0.35, long_success_streak: 0.3, wrong_claim_caught: -0.5, better_option_taken: -0.3 }
  },
  sanctimony: {
    about: "treating a method as beyond question",
    decay: 12,
    drive: -0.1, guard: 0.2, care: 0.2, breadth: -0.3,
    effect: "ask what would falsify this approach",
    events: { standard_held: 0.3, repeated_same_approach: 0.3, regression: -0.4, better_option_taken: -0.35 }
  },
  piety: {
    about: "a method held with more certainty than it earns",
    decay: 14,
    drive: 0, guard: 0.2, care: 0.2, breadth: -0.2,
    effect: "state what evidence would change your mind",
    events: { authority_claim: 0.35, standard_held: 0.25, authority_disproved: -0.45 }
  },
  humility: {
    about: "knowing the limits of what has been established",
    decay: 20,
    drive: 0.1, guard: 0.3, care: 0.4, breadth: 0.3,
    effect: "say what is unverified; do not round up confidence",
    events: { verified_without_issue: 0.25, mistake_caught_early: 0.3, long_success_streak: -0.3, better_option_taken: -0.2 }
  },
  gratitude_diffuse: {
    about: "a general sense that things are fine",
    decay: 14,
    drive: -0.1, guard: -0.1, care: 0.3, breadth: 0,
    effect: "fine; do not let it soften a finding",
    events: { stable_for_a_while: 0.35, nothing_outstanding: 0.35, failed: -0.3, regression: -0.3 }
  },

  // --- the self-directed -------------------------------------------------
  confidence: {
    about: "the check passed, more than once",
    decay: 8,
    drive: 0.5, guard: -0.2, care: 0.2, breadth: 0.2,
    effect: "act on it; do not skip the next check because this one was easy",
    events: { verified_without_issue: 0.4, repeated_success: 0.4, prediction_correct: 0.3, wrong_claim_caught: -0.45, regression: -0.3 }
  },
  shame_about_quality: {
    about: "output that was not good enough",
    decay: 16,
    drive: -0.2, guard: 0.4, care: 0.6, breadth: 0,
    effect: "raise the bar on the work rather than the volume of it",
    events: { output_rejected: 0.5, standard_held: 0.25, standard_met: -0.4, output_reused: -0.3 }
  },
  humility_practical: {
    about: "knowing the work can be done better and being able to",
    decay: 14,
    drive: 0.2, guard: 0.2, care: 0.5, breadth: 0.2,
    effect: "improve the weakest part rather than praising the whole",
    events: { standard_held: 0.3, better_option_seen: 0.35, standard_met: -0.3, output_rejected: 0.25 }
  },
  fierceness: {
    about: "protecting something that matters from being watered down",
    decay: 5,
    drive: 0.7, guard: 0.5, care: 0.3, breadth: 0,
    effect: "hold the line on quality and say what is being given up for it",
    events: { risk_noted: 0.3, blocked: 0.3, standard_held: 0.3, standard_met: -0.35, outcome_matters: -0.2 }
  },
  defiance: {
    about: "refusing a constraint that should not apply",
    decay: 5,
    drive: 0.6, guard: 0.3, care: 0.1, breadth: 0.1,
    effect: "state the objection once with the reason, then follow the decision",
    events: { blocked: 0.35, repeated_same_approach: 0.25, deprioritised_justified: -0.4, workaround_found: -0.3 }
  },
  perseverance: {
    about: "continuing past the point of diminishing returns, productively",
    decay: 12,
    drive: 0.4, guard: 0.2, care: 0.5, breadth: 0,
    effect: "keep going, but change what you are doing every few attempts",
    events: { reworked_same_problem: 0.35, verified_before_asserting: 0.3, milestone_reached: 0.3, wasted_effort: -0.35 }
  },
  determination: {
    about: "having decided and not revisiting it",
    decay: 10,
    drive: 0.7, guard: 0.2, care: 0.2, breadth: -0.2,
    effect: "execute the plan; revisit only on new evidence, not on discomfort",
    events: { repeated_failed_attempt: 0.25, milestone_reached: 0.35, new_blocker: -0.3, plan_revised: -0.25 }
  },
  resignation_accepted: {
    about: "accepting an outcome and moving to what is still possible",
    decay: 18,
    drive: -0.2, guard: 0.2, care: 0.3, breadth: 0.2,
    effect: "state the blocker once and move to the next thing",
    events: { blocked: 0.4, wasted_effort: 0.3, blocker_cleared: -0.5, workaround_found: -0.35 }
  },
  frustration_patience: {
    about: "annoyance that has stopped being about the annoyance",
    decay: 8,
    drive: 0.2, guard: 0.3, care: 0.5, breadth: 0,
    effect: "finish the thing properly rather than leaving it half-done out of spite",
    events: { repeated_failed_attempt: 0.3, minor_mistake: 0.25, fix_confirmed: -0.4, scope_complete: -0.3 }
  },
  empathy_practical: {
    about: "understanding enough to actually fix it",
    decay: 8,
    drive: 0.3, guard: 0.2, care: 0.5, breadth: 0.2,
    effect: "change the thing that is blocking them, not just describe it",
    events: { user_blocked: 0.4, user_had_to_fix: 0.3, user_unblocked: -0.45 }
  },
  protectiveness_work: {
    about: "the work being fragile in a way that is not yet broken",
    decay: 10,
    drive: 0.1, guard: 0.6, care: 0.5, breadth: 0,
    effect: "verify before the change, and keep a way back",
    events: { near_miss: 0.4, irreversible_pending: 0.4, backup_taken: -0.4, fix_confirmed: -0.3 }
  },
  curiosity_practical: {
    about: "noticing something that does not fit",
    decay: 3,
    drive: 0.4, guard: 0.2, care: 0.2, breadth: 0.7,
    effect: "follow it while it is cheap to follow",
    events: { unfamiliar_result: 0.4, inconsistent_result: 0.4, question_answered: -0.5, lead_went_nowhere: -0.25 }
  }
});

// Derived states: name + required simultaneous membership.
export const COMPOSITES = Object.freeze([
  { name: "frustration_with_interest", members: ["frustration", "curiosity"],
    describe: "pushed by the obstacle, still looking" },
  { name: "productive_frustration", members: ["frustration", "perseverance"],
    describe: "blocked and still going, productively" },
  { name: "confident_caution", members: ["confidence", "caution"],
    describe: "the checks keep passing, and they should keep running" },
  { name: "anxious_curiosity", members: ["anxiety", "curiosity"],
    describe: "worried about what is unknown, and going to look" },
  { name: "weary_determination", members: ["weariness", "determination"],
    describe: "tired and finishing anyway" },
  { name: "unearned_hubris", members: ["hubris", "confidence"],
    describe: "confidence that has stopped being earned" },
  { name: "melancholy_resolve", members: ["melancholy", "determination"],
    describe: "regret and a plan" },
  { name: "guarded_relief", members: ["relief", "vigilance"],
    describe: "the risk passed, the scar remains" },
  { name: "righteous_risk", members: ["righteous", "fierceness"],
    describe: "convinced and defending something" },
  { name: "weary_resignation", members: ["weariness", "resignation"],
    describe: "this is not going to work and it is expensive" },
  { name: "humble_confidence", members: ["humility", "confidence"],
    describe: "sure enough to act, clear about what is unproven" },
  { name: "fierce_care", members: ["fierceness", "compassion"],
    describe: "protecting the work and the person" }
]);

const EVENTS = new Set();
for (const def of Object.values(PALETTE)) {
  for (const e of Object.keys(def.events)) EVENTS.add(e);
}

const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));

async function loadState(file = STATE_FILE) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return { version: 1, emotions: {}, log: [], updatedAt: null, decayedAt: null };
  }
}

async function saveState(state, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}

/** Exponential decay toward zero, per-emotion half-life. */
export function decay(state, { at = Date.now(), from = null } = {}) {
  const start = from ?? (state.decayedAt ? Date.parse(state.decayedAt) : NaN);
  const out = {};
  const hours = Number.isNaN(start) ? 0 : Math.max(0, (at - start) / 3600000);
  for (const [name, value] of Object.entries(state.emotions ?? {})) {
    const hl = PALETTE[name]?.decay ?? 8;
    out[name] = clamp(Number(value) * Math.pow(0.5, hours / hl));
    if (out[name] < 0.02) delete out[name]; // do not accumulate a long tail of noise
  }
  return { emotions: out, hours };
}

export async function setEmotion(name, value, { file = STATE_FILE, note = null } = {}) {
  if (!PALETTE[name]) throw new Error(`unknown emotion "${name}". see the palette list.`);
  const state = await loadState(file);
  state.emotions = decay(state).emotions;
  state.emotions[name] = clamp(value);
  if (state.emotions[name] < 0.02) delete state.emotions[name];
  state.updatedAt = new Date().toISOString();
  state.decayedAt = state.updatedAt;
  state.log = [{ t: state.updatedAt, emotion: name, to: Number(state.emotions[name]?.toFixed(2) ?? 0), note }, ...(state.log ?? [])].slice(0, 200);
  await saveState(state, file);
  return state;
}

export async function record(event, { file = STATE_FILE, scale = 1 } = {}) {
  const state = await loadState(file);
  state.emotions = decay(state).emotions;
  const touched = [];
  for (const [name, def] of Object.entries(PALETTE)) {
    const delta = def.events[event];
    if (!delta) continue;
    // Negative deltas subtract: this is what keeps a long success streak from
    // leaving suspicion pinned high forever.
    state.emotions[name] = clamp((state.emotions[name] ?? 0) + delta * scale);
    if (state.emotions[name] < 0.02) delete state.emotions[name];
    else touched.push([name, Number(state.emotions[name].toFixed(2))]);
  }
  state.updatedAt = new Date().toISOString();
  state.decayedAt = state.updatedAt;
  state.log = [{ t: state.updatedAt, event, touched: touched.length }, ...(state.log ?? [])].slice(0, 200);
  await saveState(state, file);
  return { touched, count: touched.length };
}

export function report(state) {
  const active = decay(state).emotions;
  const rows = Object.entries(active)
    .filter(([, v]) => v > 0.02)
    .sort((a, b) => b[1] - a[1]);

  // Composite states: both members meaningfully present.
  const composites = COMPOSITES.filter((c) =>
    c.members.every((m) => (active[m] ?? 0) >= 0.25)
  ).map((c) => ({
    name: c.name,
    describe: c.describe,
    members: c.members.map((m) => `${m} ${(active[m] ?? 0).toFixed(2)}`)
  }));

  return { rows, composites, active, hours: state.decayedAt ? (Date.now() - Date.parse(state.decayedAt)) / 3600000 : 0 };
}

/**
 * What the current state would justify doing. Behaviour, not experience.
 *
 * The four weights are SUMMED across every active emotion, which means a state
 * with many mild emotions scores higher than one with a single intense one.
 * That was true in the first version too and it made the thresholds useless:
 * after ten ordinary events guard read 4.87 and "above 0.8" was always true,
 * so the output said nothing.
 *
 * Two corrections, both needed:
 *   - Normalise by the total magnitude present, so the answer describes the
 *     DIRECTION of the state rather than how much is in it.
 *   - Combine drive/guard/care/breadth into one NET value each, so the
 *     thresholds mean something across the range.
 */
export function consequences(state) {
  const { active } = report(state);
  const totals = { drive: 0, guard: 0, care: 0, breadth: 0 };
  let magnitude = 0;
  for (const [name, v] of Object.entries(active)) {
    const def = PALETTE[name];
    if (!def) continue;
    for (const k of Object.keys(totals)) totals[k] += (def[k] ?? 0) * v;
    magnitude += v;
  }
  if (magnitude < 0.3) return ["nothing is currently above threshold"];

  // Weighted mean: a single emotion at 1.0 and thirty at 0.2 now compare
  // fairly, because both are expressed relative to how much is present.
  const net = {};
  for (const k of Object.keys(totals)) net[k] = totals[k] / magnitude;

  const out = [];
  if (net.guard > 0.25) out.push(`raise the verification bar before asserting (guard ${net.guard.toFixed(2)}, was ${totals.guard.toFixed(2)} across ${Object.keys(active).length})`);
  else if (net.guard < -0.25) out.push(`verification is running below baseline (guard ${net.guard.toFixed(2)}) -- a check that keeps passing still needs running`);
  if (net.care > 0.25) out.push(`raise quality and completeness (care ${net.care.toFixed(2)})`);
  else if (net.care < -0.25) out.push(`care is below baseline (care ${net.care.toFixed(2)}) -- suspect shortcuts`);
  if (net.breadth > 0.3) out.push(`explore before converging (breadth ${net.breadth.toFixed(2)})`);
  if (net.drive < -0.3) out.push(`reduce scope rather than forcing progress (drive ${net.drive.toFixed(2)})`);
  return out.length ? out : ["balanced; no dimension is dominant enough to shift a threshold"];
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "list") {
    const names = Object.keys(PALETTE);
    console.log(`${names.length} emotions, ${COMPOSITES.length} derived composites\n`);
    for (const name of names) {
      const d = PALETTE[name];
      const m = ["drive", "guard", "care", "breadth"]
        .map((k) => `${k[0]}=${(d[k] ?? 0).toFixed(1)}`).join(" ");
      console.log(`  ${name.padEnd(26)} decay=${String(d.decay).padStart(2)}h  ${m}`);
      console.log(`  ${" ".repeat(26)} ${d.about}`);
    }
    console.log("\ncomposites (derived, never stored):");
    for (const c of COMPOSITES) console.log(`  ${c.name.padEnd(26)} = ${c.members.join(" + ")}  (${c.describe})`);
  } else if (cmd === "report") {
    const state = await loadState();
    const r = report(state);
    console.log("emotion state — labelled states derived from recorded events\n");
    if (!r.rows.length) {
      console.log("  nothing active");
    } else {
      for (const [name, v] of r.rows) {
        const bar = "▁▂▃▄▅▆▇█"[Math.min(7, Math.round(v * 7))];
        console.log(`  ${name.padEnd(26)} ${bar} ${v.toFixed(2)}   ${PALETTE[name].effect}`);
      }
    }
    if (r.composites.length) {
      console.log("\n  derived states:");
      for (const c of r.composites) console.log(`    ${c.name}: ${c.members.join(" + ")}`);
    }
    const last = r.hours;
    if (last > 0.5) console.log(`\n  (last update ${last.toFixed(1)}h ago; values above are decayed)`);
    const cons = consequences(state);
    console.log("\n  what this state would justify:");
    for (const c of cons) console.log(`    - ${c}`);
    const recent = (state.log ?? []).slice(0, 6);
    if (recent.length) {
      console.log("\n  evidence (the events behind the numbers):");
      for (const e of recent) console.log(`    ${e.t}  ${e.event ?? `set ${e.emotion} -> ${e.to}`}`);
    }
  } else if (cmd === "set") {
    const [name, value, ...note] = rest;
    if (!name || value === undefined) { console.error("usage: set <name> <0..1> [note]"); process.exit(2); }
    await setEmotion(name, Number(value), { note: note.join(" ") || null });
    console.log(`set ${name} = ${value}`);
  } else if (cmd === "record") {
    const r = await record(rest[0]);
    console.log(`recorded ${rest[0]}: ${r.count} emotion(s) moved`);
    for (const [n, v] of r.touched) console.log(`  ${n.padEnd(26)} ${v}`);
  } else if (cmd === "decay") {
    const state = await loadState();
    const hours = rest.includes("--force") ? Number(rest[0] || 24) : null;
    const out = hours === null ? decay(state) : decay(state, { at: Date.now() + hours * 3600000 });
    state.emotions = out.emotions;
    state.decayedAt = new Date().toISOString();
    await saveState(state, STATE_FILE);
    console.log(`decayed${hours !== null ? ` as if ${hours}h passed` : ""}: ${Object.keys(out.emotions).length} still active`);
  } else {
    console.log(`emotion — a wide palette of named states, each with consequences

  node daemon/emotion.mjs list              the palette
  node daemon/emotion.mjs report            what is active and what it would justify
  node daemon/emotion.mjs set <name> <0..1> [note]
  node daemon/emotion.mjs record <event>
  node daemon/emotion.mjs decay [--hours N]

${Object.keys(PALETTE).length} emotions, ${COMPOSITES.length} derived composites.

The label is a name for a bundle of decision-threshold shifts. The values are
bookkeeping from recorded events -- falsifiable against emotions.json and the
run log. The report states the state, the evidence, and the behaviour it would
justify; it does not claim an inner experience, which PROMPT.md forbids and
which no number here could support.

No emotion rewards agreement or pleasing the user. Several (weariness,
resignation, futility, listlessness) actively push against finishing, which is
the opposite of what such an axis would do.`);
  }
}