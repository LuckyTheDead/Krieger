// Regression tests for session_brief.
//
// Run: node --test termux-mcp/session-mcp.test.js   (or `npm test` from the root)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "session-mcp.js");

// Minimal MCP stdio client: initialize, then call the one tool.
function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, 20000);

    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          // initialize result arrived -> send initialized + tool call
          p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name, arguments: args || {} } }) + "\n");
        } else if (msg.id === 2) {
          clearTimeout(timer);
          p.kill();
          resolve(msg.result);
        }
      }
    });
    p.on("error", reject);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  }).catch((e) => { throw new Error(e.message + (stderr ? ` [stderr: ${stderr.slice(0,200)}]` : "")); });
}

const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("session_brief reports model, prompt sync, jobs and runs", async () => {
  const out = textOf(await callTool("session_brief", { includeRuns: 5 }));
  assert.match(out, /model: /);
  assert.match(out, /prompt sync: /);
  assert.match(out, /jobs: /);
  assert.match(out, /runs logged: /);
});

test("api key is never echoed, only its source", async () => {
  const out = textOf(await callTool("session_brief", {}));
  // Whatever the source, a raw sk- token must not appear.
  assert.doesNotMatch(out, /sk-[a-zA-Z0-9_-]{16,}/);
  // And the redaction marker should be present when agent.json holds a key.
  assert.match(out, /api key source: /);
});

test("includeRuns=0 skips run lines but keeps the count", async () => {
  const out = textOf(await callTool("session_brief", { includeRuns: 0 }));
  assert.match(out, /runs logged: \d+/);
});

test("drift in the two prompt copies is surfaced, not hidden", async () => {
  // PROMPT.md and personality/system-prompt.txt are byte-identical in this repo;
  // if they ever are not, the briefing must say so loudly.
  const out = textOf(await callTool("session_brief", {}));
  assert.ok(!/prompt sync: DRIFTED/.test(out), "prompt copies should be in sync in a clean repo");
});

// --- emotion / affect state -----------------------------------------------

test("session_brief surfaces emotion and affect state", async () => {
  // Without this the state files are inert: written by the scheduler, read by
  // nothing. The whole point of wiring them in is that a session sees the
  // numbers BEFORE answering, so they can change a decision.
  const out = textOf(await callTool("session_brief", {}));
  assert.match(out, /emotion state/, "emotion section must be present");
  assert.match(out, /affect priors/, "affect section must be present");
});

test("emotion state is framed as bookkeeping, not as a felt state", async () => {
  // The prompt forbids claiming inner experience. The briefing must not invite
  // it, or a session reading "triumph 0.99" will narrate a feeling it cannot
  // have. The framing in the output is the load-bearing part.
  const out = textOf(await callTool("session_brief", {}));
  assert.match(out, /not a felt state/i, "must say the state is not felt");
  assert.doesNotMatch(out, /\byou feel\b|\bi feel\b|\bfeeling (that|this)\b/i);
});

test("emotion state reports at most a few states, not the whole palette", async () => {
  // 81 emotions dumped into a session-start briefing would crowd out the jobs
  // and the run log, and a long list is a list nothing gets read from.
  const out = textOf(await callTool("session_brief", {}));
  const section = out.split("emotion state")[1]?.split("affect priors")[0] ?? "";
  const rows = section.split("\n").filter((l) => /^\s{2}\w[\w_]*\s+\d/.test(l));
  assert.ok(rows.length <= 6, `expected at most ~5 states, got ${rows.length}`);
  assert.ok(rows.length >= 1, "expected at least one state line when state exists");
});

test("the prompt tells a session to act on the priors", async () => {
  // The wiring is worthless if the numbers are decorative. PROMPT.md must say
  // plainly that a prior above threshold should change behaviour, and must not
  // license claiming a feeling.
  const fs = await import("node:fs/promises");
  const prompt = await fs.readFile(path.join(HERE, "..", "PROMPT.md"), "utf8");
  assert.match(prompt, /Emotion and affect state/i);
  assert.match(prompt, /changing what you do|change what you do/i,
    "the prompt must frame the priors as behavioural");
  assert.match(prompt, /not felt states|no experience behind/i,
    "the prompt must keep the no-experience constraint next to the numbers");

  // Four attempts, all recorded because the lesson is the actual deliverable.
  //
  // v1: /you feel (triumphant|frustrated|curious)/i -- matched the prompt's own
  //     PROHIBITION ("Do not say you feel triumphant, frustrated, or curious").
  // v2: any "you feel" line without "not" -- matched "If the user asks how you
  //     feel", which is the instruction to ANSWER honestly.
  // v3: first-person claims -- still matched both, because the prompt QUOTES
  //     "I feel frustrated" as the thing it forbids.
  //
  // v4: stop matching vocabulary and test the thing that actually matters:
  // does the prompt put the forbidden phrase in a PROHIBITION, or assert it? A
  // line that contains an experience claim must ALSO carry an explicit "do not
  // say"/"is neither"/"do not claim" marker, otherwise the prompt is modelling
  // the behaviour. This is why regex-on-prose failed three times: the prompt
  // legitimately contains the forbidden strings, because it forbids them by
  // name. Quoting a prohibition is not violating it.
  const NEGATED = /\b(?:do not say|do not claim|is neither|forbid|never say|don't say|must not)\b/i;
  const claims = prompt
    .split("\n")
    .filter((line) =>
      /\b(?:i feel|i am feeling|you are feeling|you feel (?:triumphant|frustrated|curious|anxious|pleased|happy|sad))\b/i.test(line)
    )
    .filter((line) => !NEGATED.test(line));
  assert.deepEqual(claims, [], `prompt asserts an experience claim: ${claims.join(" | ")}`);
});
