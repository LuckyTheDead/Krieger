// Dedicated MCP server for Termux:API.
//
// Why this exists: Termux:API commands hang rather than fail when the bridge to
// the com.termux.api app is unhealthy. Diagnosed 2026-09-30: `am broadcast`
// from the Termux shell succeeds (rc=0), the app is alive, but the client never
// receives its reply and blocks indefinitely. Through `shell_exec` that means
// every call burns a tool round-trip and leaks a process. This server enforces
// a hard timeout, kills the process group on expiry, and returns a clean
// TIMEOUT result instead of hanging the agent.
//
// Design constraints, all learned the hard way:
//   - No arbitrary command strings. A fixed catalog with declared flags per
//     entry, so this cannot become a backdoor around shell_exec's intent.
//   - Every call is bounded in time AND in output size. A hanging bridge must
//     never be able to wedge the session.
//   - Process-group kill (SIGKILL on -pid) so the shim and its `am` child both
//     die. Killing only the wrapper orphans the child.
//   - Everything returned is redacted: termux-apps-info-env-variable and
//     friends can dump environment variables, which is where a key would live.
//
// NOTE: output goes to stdout in line-delimited JSON. Do not print to stdout
// for anything else -- it will corrupt the MCP framing.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BIN_DIR = process.env.TERMUX_API_BIN_DIR || "/data/data/com.termux/files/usr/bin";
const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

// Mirrors SECRET_PATTERNS in daemon/lib/core.mjs.
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{16,}/g,
  /hf_[a-zA-Z0-9]{20,}/g,
  /gh[pousr]_[a-zA-Z0-9]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,
];

function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// args: declared flags, in order. A key present in the caller input becomes the
// flag's value; absent means the flag is omitted entirely. Declaring them here
// (rather than passing a string through) is what keeps this from being a shell.
const CATALOG = {
  // --- diagnostics ---
  battery: { bin: "termux-battery-status", args: [], doc: "Battery state, charging, health." },
  info: { bin: "termux-info", args: [], doc: "Termux install details, repos, env vars." },
  wifi: { bin: "termux-wifi-connectioninfo", args: [], doc: "Wi-Fi SSID, signal, link speed." },
  "network-info": { bin: "termux-wifi-scaninfo", args: [], doc: "Scan results for nearby networks." },
  "storage-info": { bin: "termux-disk-usage", args: [], doc: "Free space per partition." },
  location: { bin: "termux-location", args: [], doc: "Current location (provider dependent)." },
  "job-list": { bin: "termux-job-scheduler", args: { pending: "-p" }, flagsOptional: true, doc: "Pending Android JobScheduler jobs." },

  // --- notifications (visible to the user) ---
  toast: {
    bin: "termux-toast",
    args: { title: "-t", text: "-c" },
    doc: "Brief toast. title/text. Not a notification; easy to miss.",
  },
  notify: {
    bin: "termux-notification",
    args: { title: "-t", text: "-c", id: "-i", priority: "-p" },
    doc: "Status-bar notification. title/text required; id makes it replaceable.",
  },
  vibrate: { bin: "termux-vibrate", args: { durationMs: "-d" }, doc: "Vibrate. durationMs, e.g. 500." },
  tts: { bin: "termux-tts-speak", args: { text: "-t", mode: "-r" }, doc: "Speak text aloud. text." },

  // --- clipboard ---
  "clipboard-get": { bin: "termux-clipboard-get", args: [], doc: "Read clipboard text." },
  "clipboard-set": { bin: "termux-clipboard-set", args: { text: "-t" }, doc: "Write clipboard text. text." },

  // --- jobs ---
  "job-register": {
    bin: "termux-job-scheduler",
    args: { jobId: "--job-id", script: "-s", periodMs: "--period-ms", network: "--network" },
    doc: "Register an Android job. jobId/script required. Android floor is 900000ms.",
  },
  "job-cancel": { bin: "termux-job-scheduler", args: { jobId: "--cancel" }, doc: "Cancel one job by jobId." },
  "job-cancel-all": { bin: "termux-job-scheduler", args: { cancelAll: "--cancel-all" }, flagsOptional: true, doc: "Cancel every pending job." },
};

// A catalog entry with no declared args still needs its boolean flag sent, or
// the underlying tool prints usage and exits.
function buildArgv(entry, input) {
  const argv = [path.join(BIN_DIR, entry.bin)];
  const declared = Object.keys(entry.args);
  for (const [key, flag] of Object.entries(entry.args)) {
    const val = input?.[key];
    if (val === undefined || val === null) continue;
    argv.push(flag, String(val));
  }
  // Boolean-style entries (e.g. -p, --cancel-all) carry no value.
  if (entry.flagsOptional && declared.length === 1 && input?.pending === true) argv.push(entry.args.pending);
  return argv;
}

function run(argv, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: os.homedir(),
        // Credentials are stripped: a job or tool here should not be able to
        // read the key that pays for model calls.
        env: (() => {
          const e = { ...process.env };
          delete e.OPENROUTER_API_KEY;
          delete e.HF_TOKEN;
          delete e.HUGGINGFACE_TOKEN;
          return e;
        })(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      resolve({ kind: "spawn-failed", message: err.message, code: null, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole group: the shim forks `am`, and killing only the shim
      // leaves the child holding the socketpair.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout?.on("data", (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr?.on("data", (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };

    child.on("error", (err) => finish({ kind: "error", message: err.message, code: null }));
    child.on("close", (code, signal) => finish({ kind: "exited", code, signal }));
  });
}

function render(name, res, timeoutMs) {
  const entry = CATALOG[name];
  const head = `[${name}] ${entry.bin} (timeout ${timeoutMs}ms)`;
  if (res.kind === "spawn-failed") return `${head}\nSPAWN FAILED: ${res.message}`;
  if (res.timedOut) {
    return [
      `${head}`,
      `RESULT: TIMEOUT after ${timeoutMs}ms — the Termux:API bridge did not answer.`,
      "",
      "This is the known symptom of an unhealthy API bridge: the broadcast is",
      "delivered but the reply never arrives, so the client blocks.",
      "Nothing was left running (process group killed).",
      "Verify from an interactive Termux session with: termux-battery-status"
    ].join("\n");
  }
  if (res.kind === "error") return `${head}\nERROR: ${res.message}`;
  const out = res.stdout?.trim() || "(empty)";
  const err = res.stderr?.trim();
  return redact([
    `${head}`,
    `exit: ${res.code}${res.signal ? ` (signal ${res.signal})` : ""}`,
    "",
    out,
    ...(err ? ["", "stderr:", err] : [])
  ].join("\n"));
}

const server = new McpServer({ name: "termux-api", version: "1.0.0" });

const NAMES = Object.keys(CATALOG);

server.tool(
  "termux_api_commands",
  `List every Termux:API command this server exposes, with its accepted arguments. Names: ${NAMES.join(", ")}. Call this if unsure of a command name or its flags.`,
  {},
  async () => ({
    content: [{
      type: "text",
      text: NAMES.map((n) => {
        const e = CATALOG[n];
        const flags = Object.entries(e.args).map(([k, f]) => `${k} -> ${f}`).join(", ") || "(no arguments)";
        return `${n}\n  ${e.doc}\n  binary: ${e.bin}\n  args: ${flags}`;
      }).join("\n\n")
    }]
  })
);

server.tool(
  "termux_api",
  "Run one Termux:API command by name. Bounded by a hard timeout and killed on expiry, so a broken API bridge returns TIMEOUT instead of hanging. Output is size-capped and redacted. Use termux_api_commands for the catalog.",
  {
    command: z.enum(NAMES).describe("Command name from the catalog"),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
      .describe("Named arguments, e.g. {title: 'hi', text: 'there'}"),
    timeoutMs: z.number().int().min(1000).max(120000).optional()
      .describe("Hard timeout. Default 15000. Raising it will not fix a dead bridge.")
  },
  async ({ command, args, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
    const entry = CATALOG[command];
    if (!entry) {
      return { content: [{ type: "text", text: `unknown command: ${command}` }], isError: true };
    }
    const res = await run(buildArgv(entry, args), timeoutMs);
    const text = render(command, res, timeoutMs);
    return { content: [{ type: "text", text }], isError: res.timedOut || res.kind === "error" };
  }
);

server.tool(
  "termux_api_health",
  "Probe whether the Termux:API bridge works from this agent's shell. Runs one pure-shell command (known to work without the bridge) and one real API command under a short timeout, then reports which layer is broken.",
  { timeoutMs: z.number().int().min(1000).max(60000).optional() },
  async ({ timeoutMs = 8000 }) => {
    const local = await run([path.join(BIN_DIR, "termux-info")], timeoutMs);
    const bridged = await run([path.join(BIN_DIR, "termux-battery-status")], timeoutMs);

    const lines = ["Termux:API bridge health", ""];
    lines.push(`bin dir: ${BIN_DIR}`);
    lines.push(`termux-info (pure shell, no bridge): ${local.timedOut ? `TIMEOUT ${timeoutMs}ms` : `exit ${local.code}`}`);
    lines.push(`termux-battery-status (needs bridge): ${bridged.timedOut ? `TIMEOUT ${timeoutMs}ms` : `exit ${bridged.code}`}`);
    lines.push("");

    if (!local.timedOut && bridged.timedOut) {
      lines.push("VERDICT: Termux itself is fine; the bridge to com.termux.api is not answering.");
      lines.push("Broadcasts are delivered but replies never return. Raising the timeout will not help.");
    } else if (!local.timedOut && !bridged.timedOut && bridged.code === 0) {
      lines.push("VERDICT: bridge healthy.");
    } else {
      lines.push("VERDICT: inconclusive — see exit codes above.");
    }
    return { content: [{ type: "text", text: redact(lines.join("\n")) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
