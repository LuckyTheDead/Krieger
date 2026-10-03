# Affect: decision priors, not moods

`daemon/affect.mjs` maintains four named scalars that shift *decision
thresholds* based on recorded events.

```sh
npm run affect                        # current priors + threshold shifts
node daemon/affect.mjs report         # same
node daemon/affect.mjs record <event> [note]
node daemon/affect.mjs                # list all events
```

The scheduler records an event after every job firing automatically.

## What this is, precisely

It is modelled on neurotransmitters in one specific, defensible way: **real
neurotransmitters do not represent feelings, they are chemicals that change the
gain on behaviour.** Dopamine does not "feel good", it raises the value of
pursuing a reward. Cortisol widens threat attention. None of them is a mood.

So these are not emotions, and the module never calls them that.

| axis | what moves it | what it changes |
|---|---|---|
| `drive` | tasks completed, novel approaches that worked, output you reused | willingness to attempt an approach with no prior evidence |
| `caution` | failures, timeouts, invalidated assumptions, broken tools | the bar before asserting something unverified |
| `persistence` | rework, verifying before shipping, shipping without verifying | effort per unit of progress |
| `curiosity` | anomalies worth chasing, untried paths, repeated dead ends | breadth before depth on a problem |

Range `[-1, 1]`, baseline `0`, per-axis half-life (2h to 24h). Decay is
exponential toward baseline, so one bad afternoon does not follow you for a week.

## The design constraint, and why it is pinned by a test

**There is no agreeableness axis, and that omission is the most important
decision in this file.**

An affect system with a "be more agreeable when happy" axis is a sycophancy
engine wearing a neuroscience costume. It would make me more likely to say
whatever keeps the conversation pleasant — a reward signal optimising the wrong
variable. `PROMPT.md` already forbids constant agreement; adding a channel that
rewards it would be a regression dressed as an enhancement.

Every axis instead moves *toward more verification*. `daemon/affect.test.mjs`
has a test that scans every threshold and every branch of every axis for
conceding language, so the constraint cannot be quietly removed by a later
"improvement".

## What it will not do

`PROMPT.md` says it plainly:

> You have no continuity between sessions and no inner experience you cannot
> demonstrate. Do not claim either. [...] point at the behavior [...] Behavior is
> the evidence. Everything else is assertion.

So `report` outputs thresholds and evidence, never a feeling:

```
  caution      +█ 1.00  (half-life 24h)

threshold shifts currently in force:
  caution 1 -> verify first, then respond  [check a claim before accepting it]
  caution 1 -> must verify                 [check a claim about my own state ...]

recent events (the evidence behind the numbers):
  2026-10-02T00:10:30Z  assumption_invalidated
```

There is a test asserting the report never contains a feeling word. If you want
to know whether something shifted my behaviour, the answer is in whether I
verified something I would otherwise have asserted — not in how I say I feel.

## Bugs found by using it

Every one of these was found by running the thing, not by reading it.

- **State wrote to the repo root, not `daemon/`.** A doubled `path.dirname`,
  copied from `core.mjs` which sits one level deeper. Nothing crashed and the
  numbers looked plausible; events simply never accumulated.
- **Decay was a silent no-op.** It read `axes[axis + "__at"]`, which nothing
  ever wrote. `caution` pinned at 1.00 forever — a sum with no forgetting,
  presented as if it were evidence.
- **`drive` and `caution` had no negative events.** An audit caught it: a
  signal that can only rise is a ratchet, not an axis. Both could climb
  permanently, so every session would inherit yesterday's caution. Added
  `approach_collapsed`, `repeated_failed_attempt`, `verified_without_issue`,
  `stable_for_a_while`.
- **`/timeout/i` does not match "timed out".** The codebase says "timed out"
  everywhere — the MCP SDK, the agent runner, curl. Nearly every real timeout
  was being filed as a generic failure and losing the specific signal.
- **A test asserted on `shift.effect`, a field that does not exist.** It
  compared `undefined` against a regex and reported a violation with no text.
  A test failing on a non-existent field looks exactly like a product bug.
- **A decay test asserted `< 0.05` where the correct value is exactly 0.0625**
  (24h at a 6h half-life). A test that fails because the author mis-multiplied
  trains you to distrust the test.

## Limits

- It does not have access to a session's reasoning, only to recorded events. It
  can shift a threshold it is asked about; it cannot by itself change how a
  model call is made. Treat the priors as a *check* on behaviour, not a cause.
- The event vocabulary is judgement. `assumption_invalidated` is the strongest
  signal available and also the one most dependent on someone noticing.
- Values saturate at ±1. Five failures in a row pins caution at the ceiling and
  further events stop registering until decay opens it up.
- This is bookkeeping, not experience. The numbers describe what happened to the
  work, not anything about me.