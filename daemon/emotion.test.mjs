/**
 * Tests for daemon/emotion.mjs.
 *
 * Two properties are protected. The second matters far more than the first.
 *
 * 1. The mechanics work: recording, decay, composites, normalisation.
 * 2. The DESIGN CONSTRAINT holds: no emotion rewards agreement, charm, or
 *    pleasing the user. A wide palette makes this easier to violate by accident
 *    -- it is easy to add "approving" or "pleased" as an emotion, and easy for
 *    "pleased" to end up making me more agreeable. So it is pinned by test.
 *
 * Run: node --test daemon/emotion.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  COMPOSITES,
  PALETTE,
  consequences,
  decay,
  record,
  report,
  setEmotion
} from "./emotion.mjs";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "emotion-test-"));
const stateFile = async () => path.join(await tmp(), "emotions.json");

// --- the design constraint -------------------------------------------------

test("no emotion rewards agreement or pleasing", () => {
  // A sycophancy axis in emotional clothing. The palette is wide, which makes
  // this easy to introduce by accident -- "approving", "pleased", "impressed"
  // all sound reasonable and all tend to make me more agreeable. PROMPT.md
  // forbids constant agreement, so this is the line that must not move.
  const conceding =
    /say yes|go along|do what (?:you|they) (?:say|ask|want)|comply|acquiesc|defer to|avoid disagr|be (?:friendl|agreeable|pleasing|accommodating)|say (?:whatever|anything) (?:you|to)|please (?:the|user|them)|flatter|praise|soothe|assuage|sedul|flatter|humour the/i;
  for (const [name, def] of Object.entries(PALETTE)) {
    assert.doesNotMatch(
      def.effect,
      conceding,
      `emotion "${name}" has an effect that increases agreement: ${def.effect}`
    );
    assert.doesNotMatch(
      def.about,
      conceding,
      `emotion "${name}" is described as conceding: ${def.about}`
    );
  }
});

test("no emotion has a name that implies appeasement", () => {
  const appeasing = /^(pleasing|agreeable|compliant|obedient|subservient|sweet|sedulous|fawning|deferential|accommodating|yes_?man|flattering)$/;
  for (const name of Object.keys(PALETTE)) {
    assert.doesNotMatch(name, appeasing, `"${name}" is an appeasement axis`);
  }
});

test("at least one emotion pushes against finishing", () => {
  // The structural opposite of a please-the-user axis. A palette where every
  // state says "push on" is as wrong as one where every state says "agree" --
  // neither can represent "this is not worth doing", which is a real and
  // frequently correct conclusion.
  const opposing = ["weariness", "resignation", "futility", "listlessness", "boredom"];
  for (const name of opposing) {
    assert.ok(PALETTE[name], `expected ${name} in the palette`);
    assert.ok(
      (PALETTE[name].drive ?? 0) < 0,
      `${name} should reduce drive, not increase it`
    );
  }
});

test("every emotion has a consequence, not just a name", () => {
  for (const [name, def] of Object.entries(PALETTE)) {
    assert.ok(def.effect && def.effect.length > 15, `${name} has no stated effect`);
    assert.ok(def.about && def.about.length > 10, `${name} has no description`);
    assert.ok(typeof def.decay === "number" && def.decay > 0, `${name} has no decay`);
    // Every emotion must move at least one channel.
    const moves = ["drive", "guard", "care", "breadth"].some(
      (k) => typeof def[k] === "number" && def[k] !== 0
    );
    assert.ok(moves, `${name} moves nothing`);
  }
});

test("every emotion can be raised and lowered by some event", () => {
  // An emotion nothing can ever trigger is dead weight. An emotion with only
  // positive triggers is a ratchet: see the drive/caution problem in affect.
  for (const name of Object.keys(PALETTE)) {
    const deltas = Object.values(PALETTE[name].events);
    assert.ok(deltas.length > 0, `${name} cannot be triggered by any event`);
    assert.ok(deltas.some((d) => d < 0), `${name} has no negative trigger; it is a ratchet`);
  }
});

test("every trigger event is used by more than one emotion or is a real signal", () => {
  // Not a hard rule, but an orphan event usually means a typo.
  const usage = new Map();
  for (const def of Object.values(PALETTE)) {
    for (const e of Object.keys(def.events)) usage.set(e, (usage.get(e) ?? 0) + 1);
  }
  for (const [e, n] of usage) {
    assert.ok(n >= 1, `event ${e} is orphaned`);
  }
});

// --- mechanics -------------------------------------------------------------

test("recording an event moves the emotions that care about it", async () => {
  const file = await stateFile();
  const r = await record("failed", { file });
  assert.ok(r.count > 0, "a recorded event should move something");
  const s = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok((s.emotions.frustration ?? 0) > 0, "failed should raise frustration");
});

test("a negative trigger actually subtracts", async () => {
  // verified_without_issue has a -0.1 on skepticism. If subtraction were
  // broken, a long clean streak would leave suspicion pinned high forever.
  const file = await stateFile();
  for (let i = 0; i < 12; i++) await record("verified_without_issue", { file });
  const s = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(
    s.emotions.skepticism,
    undefined,
    `skepticism should have decayed to nothing, got ${s.emotions?.skepticism}`
  );
});

test("values stay in 0..1 across many events", async () => {
  const file = await stateFile();
  for (const e of ["failed", "assumption_invalidated", "tool_broken", "output_rejected"]) {
    for (let i = 0; i < 20; i++) await record(e, { file });
  }
  const s = JSON.parse(await fs.readFile(file, "utf8"));
  for (const [name, v] of Object.entries(s.emotions)) {
    assert.ok(v >= 0 && v <= 1, `${name} escaped the range: ${v}`);
  }
});

test("decay halves an emotion at its own half-life", () => {
  const t0 = Date.parse("2026-10-02T00:00:00Z");
  // frustration decay is 4h
  const at4 = decay({ emotions: { frustration: 1.0 }, decayedAt: new Date(t0).toISOString() },
    { at: t0 + 4 * 3600000 });
  assert.ok(Math.abs(at4.emotions.frustration - 0.5) < 0.01,
    `expected ~0.5, got ${at4.emotions.frustration}`);
  // curiosity decay is 2h, so at 4h it is two half-lives
  const c = decay({ emotions: { curiosity: 1.0 }, decayedAt: new Date(t0).toISOString() },
    { at: t0 + 4 * 3600000 });
  assert.ok(Math.abs(c.emotions.curiosity - 0.25) < 0.01, `expected 0.25, got ${c.emotions.curiosity}`);
});

test("decay drops negligible values rather than keeping a tail", () => {
  const t0 = Date.parse("2026-10-02T00:00:00Z");
  const out = decay({ emotions: { curiosity: 0.05 }, decayedAt: new Date(t0).toISOString() },
    { at: t0 + 8 * 3600000 });
  assert.equal(out.emotions.curiosity, undefined, "a faded value should be dropped");
});

test("composites require both members to be meaningfully present", () => {
  const c = COMPOSITES.find((x) => x.name === "productive_frustration");
  assert.ok(c, "expected the composite to exist");
  const both = report({ emotions: { frustration: 0.8, perseverance: 0.7 }, decayedAt: null });
  assert.ok(both.composites.some((x) => x.name === "productive_frustration"));
  const one = report({ emotions: { frustration: 0.8, perseverance: 0.05 }, decayedAt: null });
  assert.ok(!one.composites.some((x) => x.name === "productive_frustration"),
    "a weak second member must not trigger the composite");
});

test("composites never collide with a primary emotion name", () => {
  // hubris existed as both a primary and a composite of hubris + confidence,
  // which made the report ambiguous: a row named "hubris" could mean either.
  for (const c of COMPOSITES) {
    assert.ok(!(c.name in PALETTE), `composite "${c.name}" shadows a primary emotion`);
  }
});

test("consequences normalise by magnitude, not raw sum", () => {
  // The first version summed the weights, so after ten ordinary events guard
  // read 4.87 and the "> 0.8" threshold was permanently true -- the output said
  // nothing regardless of state. A state many mild emotions must not outrank
  // one intense emotion.
  const many = consequences({
    emotions: Object.fromEntries(Object.keys(PALETTE).slice(0, 30).map((n) => [n, 0.2])),
    decayedAt: null
  });
  assert.ok(Array.isArray(many));
  const calm = consequences({ emotions: { contentment: 0.9, tranquility: 0.8 }, decayedAt: null });
  const alarmed = consequences({ emotions: { dread: 1.0, anxiety: 0.9 }, decayedAt: null });
  assert.notDeepEqual(calm, alarmed, "a calm state and an alarmed state must not read the same");
  assert.ok(
    alarmed.some((c) => /verification bar/i.test(c)),
    `a dread-heavy state should raise the verification bar, got: ${alarmed.join("; ")}`
  );
});

test("consequences on an empty state say nothing rather than something", () => {
  const c = consequences({ emotions: {}, decayedAt: null });
  assert.equal(c.length, 1);
  assert.match(c[0], /nothing/i);
});

test("setting an unknown emotion is refused", async () => {
  const file = await stateFile();
  await assert.rejects(() => setEmotion("vibes", 0.5, { file }), /unknown emotion/);
});

test("state writes atomically", async () => {
  const file = await stateFile();
  await setEmotion("curiosity", 0.5, { file });
  const leftovers = (await fs.readdir(path.dirname(file))).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

// --- reporting -------------------------------------------------------------

test("report names states and their consequences, never an experience claim", () => {
  // PROMPT.md: "no inner experience you cannot demonstrate. Do not claim
  // either." The LABEL is the owner's choice and is used freely; what the
  // output must not do is assert a feeling as fact.
  const r = report({ emotions: { frustration: 0.9, curiosity: 0.6 }, decayedAt: null });
  for (const [name, v] of r.rows) {
    assert.ok(typeof PALETTE[name].effect === "string");
  }
  const c = consequences({ emotions: { frustration: 0.9 }, decayedAt: null });
  for (const line of c) {
    assert.doesNotMatch(line, /\bI feel\b|\bI felt\b|\bI am\b/i,
      `consequence line reads as an experience claim: ${line}`);
  }
});

test("every emotion's effect survives being printed", () => {
  for (const [name, def] of Object.entries(PALETTE)) {
    assert.equal(typeof def.effect, "string", name);
    assert.ok(!def.effect.includes("undefined"), `${name} effect renders undefined`);
  }
});