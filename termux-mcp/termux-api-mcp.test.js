// Regression tests for the Termux:API MCP server.
//
// The point of these is not that the API bridge works -- on this device it does
// not -- but that the server never hangs, never leaks a process, and never
// echoes a secret, even when the bridge is dead. That is the contract that
// matters, because a hanging tool is what made this painful to debug by hand.
//
// Run: node --test termux-mcp/termux-api-mcp.test.js   (or `npm test` from the root)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "termux-api-mcp.js");
const BIN = "/data/data/com.termux/files/usr/bin";

function rpc(method, params, id) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

function callTool(name, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("client timeout")); }, 60000);
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.stdout.on("data", (d) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          p.stdin.write(rpc("tools/call", { name, arguments: args || {} }, 2));
        } else if (msg.id === 2) {
          clearTimeout(timer);
          p.kill();
          resolve(msg.result);
        }
      }
    });
    p.on("error", reject);
    p.stdin.write(rpc("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" }
    }, 1));
  }).catch((e) => { throw new Error(e.message + (stderr ? ` [${stderr.slice(0, 200)}]` : "")); });
}

const textOf = (r) => r.content.map((c) => c.text).join("\n");

function countApiProcs() {
  try {
    const out = execSync("ps -A 2>/dev/null | grep -c 'libexec/termux.api' || true", { encoding: "utf8" });
    return parseInt(out.trim(), 10) || 0;
  } catch { return 0; }
}

test("catalog tool lists commands and their flags", async () => {
  const out = textOf(await callTool("termux_api_commands", {}));
  assert.match(out, /battery/);
  assert.match(out, /job-register/);
  assert.match(out, /binary: termux-battery-status/);
});

test("a dead bridge returns TIMEOUT instead of hanging", async () => {
  const started = Date.now();
  const out = textOf(await callTool("termux_api", { command: "battery", timeoutMs: 3000 }));
  const elapsed = Date.now() - started;

  assert.match(out, /TIMEOUT|exit:/);
  // The whole point: bounded in time. A hanging call would blow this budget.
  assert.ok(elapsed < 30000, `call took ${elapsed}ms, should be bounded by timeout`);
});

test("unknown command is rejected rather than executed", async () => {
  const res = await callTool("termux_api", { command: "definitely-not-a-command" });
  assert.equal(res.isError, true);
});

test("timeout leaves no orphan process behind", async () => {
  const before = countApiProcs();
  await callTool("termux_api", { command: "battery", timeoutMs: 3000 });
  await new Promise((r) => setTimeout(r, 1500));
  const after = countApiProcs();

  assert.ok(after <= before, `leaked processes: ${before} -> ${after}`);
});

test("pure-shell command still works when the bridge is dead", async () => {
  // This is the control: termux-info does not cross the bridge, so it must
  // succeed. If this fails, the server itself is broken rather than the bridge.
  const res = await callTool("termux_api", { command: "info", timeoutMs: 10000 });
  const out = textOf(res);
  assert.doesNotMatch(out, /TIMEOUT/);
  assert.match(out, /exit: 0/);
});

test("health probe distinguishes shell layer from bridge layer", async () => {
  const out = textOf(await callTool("termux_api_health", { timeoutMs: 4000 }));
  assert.match(out, /bridge health/);
  assert.match(out, /VERDICT/);
  assert.match(out, /termux-info \(pure shell/);
  assert.match(out, /termux-battery-status \(needs bridge\)/);
});

test("output is redacted", async () => {
  // info dumps env-ish content; ensure no raw secret-shaped token survives.
  const out = textOf(await callTool("termux_api", { command: "info", timeoutMs: 10000 }));
  assert.doesNotMatch(out, /sk-[a-zA-Z0-9_-]{16,}/);
});
