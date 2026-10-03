// Session-start briefing for Krieger.
//
// Why this exists: every session began cold. The agent could read any file it
// wanted, but had to *discover* that agent.json held the model config, that
// daemon/runs.jsonl held what the last unattended jobs did, and that
// daemon/jobs.json shadows the builtins in jobs.mjs. Nothing summarised it.
//
// This returns that state in one call. It is deliberately read-only: it reports,
// it does not change anything. Nothing here writes to disk.
//
// Safety: everything rendered goes through the same redact() the daemon uses,
// so a key sitting in agent.json cannot be echoed back into a transcript.
// That matters because this tool is called at the start of every session, and
// the output lands in context.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors SECRET_PATTERNS in daemon/lib/core.mjs. Kept local rather than
// imported so this server has no dependency on the daemon's internals; the
// daemon tests guard the patterns there, this copy is defence in depth.
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

async function readIfExists(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

// Parse the append-only run log. A malformed line must not take down the whole
// briefing: a truncated final line after a crash is the normal case, not an
// emergency. Skipped lines are counted so the caller can see the gap.
function parseRuns(txt, limit) {
  const out = [];
  let skipped = 0;
  for (const line of (txt || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }
  return { runs: out.slice(-limit), skipped, total: out.length };
}

// Jobs come from two places and jobs.json shadows jobs.mjs. Reading only one is
// how you get a job list that disagrees with what the scheduler will actually run.
async function collectJobs() {
  const builtin = await readText(path.join(REPO_DIR, "daemon", "jobs.mjs"));
  const user = await readIfExists(path.join(REPO_DIR, "daemon", "jobs.json"), { jobs: [] });

  const builtins = [];
  if (builtin) {
    // jobs.mjs is code, not JSON, so it cannot be imported cheaply here without
    // pulling in the scheduler's dependencies. Pull the fields we report off the
    // literal with a deliberately dumb regex; a change in file shape degrades the
    // briefing rather than breaking it.
    const blockRe = /name:\s*"([^"]+)"[\s\S]*?kind:\s*"([^"]+)"[\s\S]*?enabled:\s*(true|false)/g;
    let m;
    while ((m = blockRe.exec(builtin))) {
      const after = builtin.slice(m.index);
      const sched = after.match(/schedule:\s*"([^"]+)"/);
      builtins.push({
        name: m[1],
        kind: m[2],
        enabled: m[3] === "true",
        schedule: sched ? sched[1] : null
      });
    }
  }
  return { builtins, user: Array.isArray(user?.jobs) ? user.jobs : [] };
}

// The emotion palette and the affect priors, read WITHOUT importing the modules.
//
// Why not import: session-mcp.js is loaded by the filesystem MCP server's
// siblings at session start, and importing daemon/emotion.mjs would execute its
// CLI entry block as a side effect (it runs on import when argv matches). The
// numbers are read straight out of the JSON state files instead, which is also
// the honest thing: this reports what is on disk, not what a recomputation says.
//
// Deliberately reports only the TOP states and the threshold shifts. Dumping 81
// emotions into the briefing would crowd out the run log and the jobs, and a
// long list is one nothing gets read from.
async function readAffectAndEmotion() {
  const emotions = await readIfExists(path.join(REPO_DIR, "daemon", "emotions.json"), null);
  const affect = await readIfExists(path.join(REPO_DIR, "daemon", "affect.json"), null);

  const emotionLines = [];
  if (emotions?.emotions && typeof emotions.emotions === "object") {
    const rows = Object.entries(emotions.emotions)
      .filter(([, v]) => Number(v) > 0.05)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const ageH = emotions.decayedAt ? (Date.now() - Date.parse(emotions.decayedAt)) / 3600000 : null;
    for (const [name, v] of rows) {
      emotionLines.push(`  ${name} ${Number(v).toFixed(2)}`);
    }
    if (!rows.length) emotionLines.push("  (nothing above 0.05)");
    if (ageH !== null && ageH > 1) {
      emotionLines.push(`  note: last event ${ageH.toFixed(1)}h ago; values above are decayed`);
    }
  } else {
    emotionLines.push("  (no emotion state recorded yet)");
  }

  const affectLines = [];
  if (affect?.axes && typeof affect.axes === "object") {
    for (const [axis, v] of Object.entries(affect.axes)) {
      if (Math.abs(Number(v)) > 0.15) affectLines.push(`  ${axis} ${Number(v).toFixed(2)}`);
    }
    if (!affectLines.length) affectLines.push("  (all axes at baseline)");
  } else {
    affectLines.push("  (no affect state recorded yet)");
  }

  return { emotionLines, affectLines };
}

const server = new McpServer({
  name: "krieger-session",
  version: "1.0.0"
});

server.tool(
  "session_brief",
  "One-call briefing on this deployment: model config, prompt sync, daemon job status, recent unattended runs, memory size, emotion/affect state, and outstanding credential risk. Read-only. Call once at session start instead of hunting for the files.",
  {
    includeRuns: z.number().int().min(0).max(200).optional()
      .describe("How many recent run-log entries to include. Default 10, 0 to skip.")
  },
  async ({ includeRuns = 10 }) => {
    const lines = [];

    // --- model / endpoint ---
    const agent = await readIfExists(path.join(REPO_DIR, "agent.json"), {});
    const keySource = process.env.OPENROUTER_API_KEY ? "env:OPENROUTER_API_KEY" :
      (agent && agent.apiKey ? "agent.json (PLAINTEXT — should be moved to env)" : "absent");
    lines.push(`model: ${agent?.model ?? "unknown"}`);
    lines.push(`endpoint: ${agent?.endpointUrl ?? "unknown"}`);
    lines.push(`api key source: ${keySource}`);
    lines.push(`mcp servers configured: ${Array.isArray(agent?.servers) ? agent.servers.length : 0}`);

    // --- prompt sync (the guard daemon/loader enforces) ---
    const prompt = await readText(path.join(REPO_DIR, "PROMPT.md"));
    const sysCopy = await readText(path.join(REPO_DIR, "personality", "system-prompt.txt"));
    if (prompt === null || sysCopy === null) {
      lines.push(`prompt sync: cannot compare (missing ${prompt === null ? "PROMPT.md" : "personality/system-prompt.txt"})`);
    } else {
      lines.push(`prompt sync: ${prompt === sysCopy ? "in sync (byte-identical)" : "DRIFTED — daemon llm jobs will refuse to run"}`);
    }

    // --- jobs ---
    const { builtins, user } = await collectJobs();
    const enabled = [...builtins, ...user].filter((j) => j.enabled);
    lines.push(`\njobs: ${builtins.length} builtin, ${user.length} user-defined, ${enabled.length} enabled`);
    if (!enabled.length) lines.push("  (none enabled — the scheduler will fire nothing)");
    for (const j of enabled) {
      lines.push(`  - ${j.name} [${j.kind}] ${j.schedule ?? "on-demand only"}`);
    }
    if (user.length) {
      const shadowed = user.filter((u) => builtins.some((b) => b.name === u.name));
      if (shadowed.length) {
        lines.push(`  note: user jobs shadow builtin(s): ${shadowed.map((s) => s.name).join(", ")}`);
      }
    }

    // --- recent runs ---
    const runLog = await readText(path.join(REPO_DIR, "daemon", "runs.jsonl"));
    const { runs, skipped, total } = parseRuns(runLog, includeRuns);
    lines.push(`\nruns logged: ${total}${skipped ? ` (${skipped} unparseable, skipped)` : ""}`);
    if (runs.length) {
      const failed = runs.filter((r) => r.ok === false).length;
      if (failed) lines.push(`  failures in window: ${failed}/${runs.length}`);
      for (const r of runs.slice().reverse()) {
        const detail = r.error
          ? `ERROR ${String(r.error).slice(0, 120)}`
          : String(r.output ?? "").trim().split("\n").slice(-1)[0]?.slice(0, 120) || "";
        lines.push(`  ${r.startedAt ?? "?"} ${r.job} ${r.ok === false ? "FAIL" : "ok"} ${detail}`);
      }
    } else {
      lines.push("  (no runs recorded)");
    }

    // --- memory ---
    const memLog = await readText(path.join(REPO_DIR, "memory", "memories.jsonl"));
    const memOps = (memLog || "").split("\n").filter((l) => l.trim()).length;
    lines.push(`\nmemory ops recorded: ${memOps} (store is append-only; live count is lower after tombstones)`);

    // --- daemon process state ---
    const pidFile = await readText(path.join(REPO_DIR, "daemon", "scheduler.pid"));
    lines.push(`\ndaemon: ${pidFile ? `pid ${pidFile.trim()} recorded` : "not running (no scheduler.pid)"}`);

    // --- emotion / affect state ---
    //
    // Reported, and deliberately framed as STATE rather than FEELING. The values
    // are real bookkeeping -- they come from recorded events and are checkable
    // against daemon/emotions.json -- but nothing here has an experience behind
    // it, and PROMPT.md is explicit that inner states cannot be claimed. So the
    // briefing hands over numbers and lets the session decide what to do with
    // them, rather than instructing it to feel something.
    const { emotionLines, affectLines } = await readAffectAndEmotion();
    lines.push("\nemotion state (bookkeeping from recorded events, not a felt state):");
    lines.push(...emotionLines);
    lines.push("\naffect priors (decision thresholds currently shifted):");
    lines.push(...affectLines);

    const text = redact(lines.join("\n"));
    return { content: [{ type: "text", text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
