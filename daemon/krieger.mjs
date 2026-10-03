#!/usr/bin/env node
// Job control: list, enable/disable, add, remove, run now.
//
//   node daemon/krieger.mjs list
//   node daemon/krieger.mjs enable overnight-review
//   node daemon/krieger.mjs run overnight-review
//   node daemon/krieger.mjs logs [n]
//   node daemon/krieger.mjs doctor
//
// User-defined jobs live in daemon/jobs.json as { "jobs": [...] } and override
// same-named builtins. A bare array is rejected loudly rather than silently
// loading zero jobs.

import fs from "node:fs/promises";
import path from "node:path";

import {
  DAEMON_DIR,
  REPO_DIR,
  readJson,
  redact,
  writeAtomic
} from "./lib/core.mjs";
import { runJob, runShellJob, loadSystemPrompt } from "./lib/runner.mjs";
import { jobs as builtinJobs } from "./jobs.mjs";

const JOBS_FILE = path.join(DAEMON_DIR, "jobs.json");
const RUN_LOG = path.join(DAEMON_DIR, "runs.jsonl");

async function userJobs() {
  const raw = (await readJson(JOBS_FILE, null)) ?? { jobs: [] };
  if (Array.isArray(raw)) {
    throw new Error(
      `${JOBS_FILE} must be an object like { "jobs": [...] }, not a bare array.`
    );
  }
  if (!Array.isArray(raw.jobs)) {
    throw new Error(`${JOBS_FILE} has no "jobs" array.`);
  }
  return raw.jobs;
}

async function saveUserJobs(jobs) {
  await writeAtomic(JOBS_FILE, JSON.stringify({ jobs }, null, 2));
  console.log(`wrote ${jobs.length} user job(s) to ${JOBS_FILE}`);
}

async function effective() {
  const u = await userJobs();
  const seen = new Set();
  return [...u, ...builtinJobs].filter((j) => {
    if (seen.has(j.name)) return false;
    seen.add(j.name);
    return true;
  });
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "list": {
    const all = await effective();
    for (const j of all) {
      const on = j.enabled !== false;
      console.log(
        `${on ? " ON " : "off "} ${String(j.schedule ?? "-").padEnd(16)} ` +
          `${String(j.kind).padEnd(5)} ${j.name}` +
          (j.command ? `  [shell] ${String(j.command).slice(0, 70)}` : "")
      );
    }
    break;
  }

  case "enable":
  case "disable": {
    const name = rest[0];
    if (!name) throw new Error("usage: krieger enable|disable <name>");
    const all = await effective();
    const target = all.find((j) => j.name === name);
    if (!target) throw new Error(`no such job: ${name}. known: ${all.map((j) => j.name).join(", ")}`);
    const enabled = cmd === "enable";
    if (builtinJobs.some((j) => j.name === name)) {
      throw new Error(
        `"${name}" is a builtin in daemon/jobs.mjs — edit that file, or shadow it by ` +
        `adding a job of the same name to ${JOBS_FILE}.`
      );
    }
    const u = await userJobs();
    const existing = u.find((j) => j.name === name);
    if (existing) existing.enabled = enabled;
    else u.push({ ...target, enabled });
    await saveUserJobs(u);
    break;
  }

  case "run": {
    const name = rest[0];
    if (!name) throw new Error("usage: krieger run <name>");
    const all = await effective();
    const job = all.find((j) => j.name === name);
    if (!job) throw new Error(`no such job: ${name}`);

    const agentConfig = await readJson(path.join(REPO_DIR, "agent.json"), {});
    const state = { runLog: RUN_LOG, repoDir: REPO_DIR, daemonDir: DAEMON_DIR };

    // An explicit `run` overrides enabled: false. Typing the command is the
    // consent; otherwise a disabled job silently no-ops and looks broken.
    const forced = { ...job, enabled: true };

    const result =
      job.kind === "shell"
        ? await runShellJob(forced, { state })
        : job.kind === "agent"
          ? await (await import("./lib/agent.mjs")).runAgentJob(forced, {
              agentConfig,
              systemPrompt: await loadSystemPrompt(state),
              state
            })
          : await runJob(forced, {
              agentConfig,
              systemPrompt: await loadSystemPrompt(state),
              state
            });

    console.log(`${result.ok ? "ok" : result.skipped ? "skipped" : "FAILED"}: ${job.name} (${(result.durationMs / 1000).toFixed(1)}s)`);
    if (result.toolCalls) console.log(`tools: ${result.toolCalls} (${(result.toolNames ?? []).join(", ")})`);
    if (result.toolsRemoved?.length) console.log(`withheld: ${result.toolsRemoved.join(", ")}`);
    if (result.output) console.log(String(result.output).trim());
    if (result.error) console.error(String(result.error).trim());
    break;
  }

  case "logs": {
    const n = Number(rest[0] || 20);
    let raw = "";
    try {
      raw = await fs.readFile(RUN_LOG, "utf8");
    } catch {
      console.log("no run log yet");
      break;
    }
    const lines = raw.trim().split("\n").slice(-n);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        const st = e.ok ? "ok" : e.skipped ? "skip" : "FAIL";
        console.log(
          `${e.startedAt} ${st.padEnd(4)} ${String(e.job).padEnd(20)} ` +
            `${((e.durationMs ?? 0) / 1000).toFixed(1)}s  ` +
            String(e.output || e.error || "").replace(/\s+/g, " ").slice(0, 160)
        );
      } catch {
        console.log(`(unparseable) ${l.slice(0, 120)}`);
      }
    }
    break;
  }

  case "doctor": {
    const checks = [];
    const agentConfig = await readJson(path.join(REPO_DIR, "agent.json"), null);
    // agent.json is gitignored because it holds a live API key, so a fresh clone
    // -- the PC's, or any new machine -- legitimately does not have one. Saying
    // only "missing" reads as a broken checkout; it is the expected state of a
    // clone. Name the cause so it can be fixed in one step.
    const agentNote = agentConfig
      ? ""
      : "missing (gitignored: holds the API key). Create it, or set OPENROUTER_API_KEY in the env";
    checks.push([
      "agent.json readable",
      !!agentConfig,
      agentNote
    ]);
    checks.push([
      "model + endpoint set",
      !!agentConfig?.model && !!agentConfig?.endpointUrl,
      agentConfig
        ? `${agentConfig.model} @ ${agentConfig.endpointUrl}`
        : "no agent.json -- cannot read model or endpoint"
    ]);
    const key = process.env.OPENROUTER_API_KEY || agentConfig?.apiKey;
    checks.push([
      "api key resolvable",
      !!key,
      process.env.OPENROUTER_API_KEY
        ? "from env"
        : agentConfig?.apiKey
          ? "from agent.json (plaintext)"
          : "none -- agent jobs cannot run without this"
    ]);
    try {
      const a = await fs.readFile(path.join(REPO_DIR, "PROMPT.md"), "utf8");
      const b = await fs.readFile(path.join(REPO_DIR, "personality", "system-prompt.txt"), "utf8");
      checks.push(["prompt copies identical", a === b, a === b ? "" : "run npm run test:prompt"]);
    } catch (e) {
      checks.push(["prompt copies identical", false, e.message]);
    }
    try {
      await fs.access(RUN_LOG);
      checks.push(["run log exists", true, RUN_LOG]);
    } catch {
      checks.push(["run log exists", false, "no runs yet"]);
    }
    for (const [label, ok, detail] of checks) {
      console.log(`${ok ? " ok " : "FAIL"}  ${label.padEnd(24)} ${detail}`);
    }
    break;
  }

  default:
    console.log(`krieger <command>

  list                  show all jobs and their state
  enable <name>         enable a user-defined job
  disable <name>        disable a user-defined job
  run <name>            run one job immediately, print the result
  logs [n]              last n run-log entries
  doctor                preflight checks`);
    if (cmd) process.exitCode = 1;
}
