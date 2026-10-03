/**
 * Guard for the prompt-driven system-prompt architecture.
 *
 * The architecture decision (PROMPT.md is the source of truth,
 * personality/system-prompt.txt is a byte-identical copy) has no mechanism
 * keeping the two in agreement. Nothing in the MCP test suite reads either
 * file, so an edit to one could silently drift from the other and nobody
 * would find out until a session loaded a stale persona.
 *
 * These tests are the mechanism. They are cheap and they run in milliseconds.
 *
 * Run: node --test prompt-sync.test.mjs
 *
 * Standalone ESM (.mjs) so it needs no package.json at the repo root and no
 * dependencies -- this is a filesystem check, not a code test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_MD = path.join(ROOT, "PROMPT.md");
const SYSTEM_TXT = path.join(ROOT, "personality", "system-prompt.txt");
const KRIEGER_JSON = path.join(ROOT, "personality", "krieger.json");

test("PROMPT.md and personality/system-prompt.txt are byte-identical", async () => {
  const [md, txt] = await Promise.all([
    readFile(PROMPT_MD),
    readFile(SYSTEM_TXT)
  ]);

  assert.equal(
    md.length,
    txt.length,
    `size mismatch: PROMPT.md is ${md.length} bytes, system-prompt.txt is ${txt.length}. ` +
    `If one was edited, copy it over the other: ` +
    `cp ${path.relative(ROOT, SYSTEM_TXT)} ${path.relative(ROOT, PROMPT_MD)}`
  );

  assert.deepEqual(
    md,
    txt,
    "PROMPT.md and personality/system-prompt.txt have drifted. They must stay " +
    "byte-identical -- the loader reads one and a future session will get " +
    "whichever is stale."
  );
});

test("the load-bearing honesty sections survive in the prompt", async () => {
  const prompt = await readFile(PROMPT_MD, "utf8");

  // These are the constraints PROMPT.md itself says must not be removed.
  // Personality is decoration; this is the load-bearing part. If an edit
  // drops one, the edit is wrong even though it may have been intended as a
  // simplification.
  const required = [
    ["epistemic honesty section", /##\s*Epistemic honesty/],
    ["Known/Inferred/Suspected/Unknown split",
     /^\s*-\s*Known:[\s\S]*^\s*-\s*Inferred:[\s\S]*^\s*-\s*Suspected:[\s\S]*^\s*-\s*Unknown:/m],
    ["do not claim unverified self-knowledge", /persona/i],
    ["update rather than store contradictions", /contradict/i],
    ["name what you recalled", /recalled/i],
    ["push back rather than agree", /backseat driver|flawed/i],
    ["secret handling", /credential|token|key/i],
    ["personality subordinate to usefulness", /usefulness wins/i]
  ];

  const missing = required
    .filter(([, re]) => !re.test(prompt))
    .map(([label]) => label);

  assert.deepEqual(
    missing,
    [],
    `prompt is missing required sections: ${missing.join(", ")}`
  );
});

test("personality/krieger.json parses and still forbids sycophancy", async () => {
  const raw = await readFile(KRIEGER_JSON, "utf8");
  const krieger = JSON.parse(raw);

  assert.ok(krieger.personality, "krieger.json has no personality block");
  assert.ok(Array.isArray(krieger.personality.core_traits));

  const comm = krieger.personality.communication || {};
  assert.equal(
    comm.avoid_constant_agreement,
    true,
    "avoid_constant_agreement must stay true -- that is the constraint that " +
    "stops a future session from being edited into a yes-machine"
  );

  const doNot = (krieger.relationship_with_user || {}).do_not || [];
  assert.ok(
    doNot.some(d => /sycophan/i.test(d)),
    "the do_not list no longer forbids excessive sycophancy"
  );
});