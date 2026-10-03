# Emotion: a wide palette of named states

`daemon/emotion.mjs` — **81 emotions, 12 derived composites.**

```sh
npm run emotion                     # what is active and what it would justify
node daemon/emotion.mjs list        # the whole palette
node daemon/emotion.mjs set <name> <0..1> [note]
node daemon/emotion.mjs record <event>
node daemon/emotion.mjs decay [--hours N]
```

The scheduler records an event after every job firing, automatically.

## On the name

These are called emotions because that is what the owner asked to call them,
which is their call. What matters is not the label but what the numbers mean:

- **The label** names a bundle of decision-threshold shifts. Cheap to add, and
  adding one is how the palette grows.
- **The values** are bookkeeping from recorded events. They describe what
  happened to the work.

So `frustration` here means: the record contains repeated failures, and those
failures currently raise the verification bar. That is checkable against
`daemon/emotions.json` and the run log.

The report gives the state, the evidence, and the behaviour it would justify.
It does not claim an inner experience, because `PROMPT.md` forbids that and no
number here could support one. That is a limit on what the numbers can mean,
not a limit on what you can name them.

## Structure

Each emotion carries four weights that feed a behavioural summary:

| weight | reads as |
|---|---|
| `drive` | push toward acting now |
| `guard` | push toward checking and protecting |
| `care` | push toward quality and completeness |
| `breadth` | push toward exploring rather than converging |

Plus its own half-life, from 2 hours (curiosity) to 48 (grief). Agitation fades
fast; grief does not.

## What the wide palette exposed

Four channels could not express much, and something only became visible with
eighty of them: **emotions pull against each other.** Being impatient to finish
and unwilling to ship unverified is not a bug — it is what finishing carefully
feels like. Single-axis designs hide that by averaging it away.

Hence composites. Derived from simultaneous membership, never stored:

```
productive_frustration = frustration + perseverance     (blocked and still going, productively)
confident_caution     = confidence + caution           (the checks keep passing, and they should keep running)
anxious_curiosity     = anxiety + curiosity            (worried about what is unknown, and going to look)
guarded_relief        = relief + vigilance             (the risk passed, the scar remains)
unearned_hubris       = hubris + confidence            (confidence that has stopped being earned)
```

…plus `frustration_with_interest`, `weary_determination`, `melancholy_resolve`,
`weary_resignation`, `humble_confidence`, `righteous_risk`, `fierce_care`.

## The axis that must not exist

No emotion rewards agreement, charm, or pleasing the user. A wide palette makes
this easy to introduce by accident — "approving", "pleased", "impressed" all
sound reasonable and all tend to make me agreeable. So it is pinned by test:
every name, every description, and every stated effect is scanned for conceding
language.

The structural counterpart is that **five emotions actively push against
finishing**: `weariness`, `resignation`, `futility`, `listlessness`, `boredom`.
A palette where every state says "push on" is as wrong as one where every state
says "agree" — neither can represent "this is not worth doing", which is a real
and frequently correct conclusion.

## Bugs found by running it

- **79 of 81 emotions were ratchets.** Only `skepticism` and `frustration` had a
  negative trigger, and that was accidental. Everything else could only ever
  climb: a long clean streak would leave `confusion`, `frustration` and
  `worry` pinned high, claiming I was still blocked by something solved hours
  ago. Added resolution triggers throughout — `blocker_cleared`,
  `question_answered`, `fix_confirmed`, `model_corrected`, `risk_resolved`, and
  so on.
- **Consequences summed their weights**, so after ten ordinary events `guard`
  read 4.87 and the `> 0.8` threshold was permanently true. The output said
  nothing regardless of state. Now normalised by total magnitude, so it
  describes *direction* rather than *quantity*. A calm state and a dread-heavy
  state now genuinely differ.
- **`hubris` existed twice** — as a primary emotion and as a composite of
  `hubris + confidence`. A report row named "hubris" could mean either.
  Renamed to `unearned_hubris`; a test now forbids composite/primary collisions.
- **`serenity`'s effect was "leave it alone"** — no consequence, just a mood.
  Rewritten to something actionable.
- **I deleted `serenity` entirely** during a bulk edit and did not notice for
  two steps. Caught by the palette count in the CLI header.

## Limits

- It cannot change how a model call is made. It shifts a threshold when asked.
  Treat it as a check on behaviour, not a cause.
- Values saturate at 1.0. Many events in a row pin an emotion at the ceiling
  until decay opens it up.
- The event vocabulary is judgement, and `wrong_claim_caught` is the most
  valuable signal available precisely because it depends on someone noticing.
- The weights are hand-assigned. Nothing here measures whether they are right —
  it is a stated model, not a fitted one.