#!/usr/bin/env node
// Krieger unattended daemon.
//
//   node daemon/scheduler.mjs            run the scheduler (foreground)
//   node daemon/scheduler.mjs --once     fire any due job immediately, exit
//   node daemon/scheduler.mjs --dry-run  report what is scheduled, call nothing
//
// Scheduling is croner (in-process). For surviving a Termux process death, use
// termux-job-scheduler via ./install-android-job.sh, which fires this same
// script on an interval instead of relying on a resident process.

import { Cron } from "croner";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DAEMON_DIR,
  REPO_DIR,
  acquireLock,
  appendJsonl,
  ensureDir,
  nowIso,
  readJson,
  redact,
  writeAtomic
} from "./lib/core.mjs";
import { runJob, runShellJob, loadSystemPrompt } from "./lib/runner.mjs";
import { jobs as builtinJobs } from "./jobs.mjs";

const STATE_DIR = DAEMON_DIR;
const JOBS_FILE = path.join(STATE_DIR, "jobs.json");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const RUN_LOG = path.join(STATE_DIR, "runs.jsonl");
const LOCK_FILE = path.join(STATE_DIR, "scheduler.lock");

async function loadJobs() {
  const raw = await readJson(JOBS_FILE, null);
  let userJobs = [];
  if (raw !== null) {
    if (Array.isArray(raw)) {
      throw new Error(
        `${JOBS_FILE} must be an object like { "jobs": [...] }, not a bare array.`
      );
    }
    if (!Array.isArray(raw.jobs)) {
      throw new Error(`${JOBS_FILE} has no "jobs" array.`);
    }
    userJobs = raw.jobs;
  }
  // User jobs come first so a user job shadows a builtin of the same name.
  const all = [...userJobs, ...builtinJobs];
  const seen = new Set();
  return all.filter((j) => {
    if (seen.has(j.name)) return false;
    seen.add(j.name);
    return true;
  });
}

export async function loadState() {
  const s = (await readJson(STATE_FILE, null)) || {};
  return {
    repoDir: REPO_DIR,
    daemonDir: DAEMON_DIR,
    runLog: RUN_LOG,
    jobsFile: JOBS_FILE,
    stateFile: STATE_FILE,
    lastRunAt: s.lastRunAt ?? null,
    counts: s.counts ?? {},
    // name -> ISO timestamp of the next scheduled firing. Persisted, because a
    // --once invocation is a fresh process and anything kept only on an
    // in-memory object is gone by the time the next one starts.
    nextRun: s.nextRun ?? {}
  };
}

// Next firing of a job's cron expression, or null if it has no schedule (in
// which case it is run on demand only). A bad expression yields null rather
// than throwing: the job should not wedge the whole scheduler.
export function computeNextRun(job, from = new Date()) {
  if (!job.schedule) return null;
  let cron;
  try {
    cron = new Cron(job.schedule, { paused: true });
    return cron.nextRun(from) ?? null;
  } catch {
    return null;
  } finally {
    // A paused Cron holds no timer, but stop() is free and keeps the object
    // count flat in a long-running scheduler that calls this every firing.
    cron?.stop?.();
  }
}

// Is a job due to run now? Pure, so it can be tested without firing anything.
//
// A job with no schedule is on-demand only (`krieger run <name>`) and is never
// due -- previously it fell through the due check and fired on every --once.
// Otherwise it is due when force is set, or when it has no recorded next run
// (never fired), or when that time has passed.
export function isDue(job, nextRun, { now = new Date(), force = false } = {}) {
  if (!job?.schedule) return false;
  if (force) return true;
  const at = nextRun?.[job.name];
  if (!at) return true;
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return true; // corrupt entry: do not wedge
  return when <= now;
}

async function saveRunState(state, results, firedJobs) {
  const counts = { ...(state.counts || {}) };
  for (const r of results) {
    const c = (counts[r.job] ||= { ok: 0, fail: 0, skipped: 0 });
    if (r.ok) c.ok++;
    else if (r.skipped) c.skipped++;
    else c.fail++;
  }
  const nextRun = { ...(state.nextRun || {}) };
  for (const job of firedJobs) {
    const next = computeNextRun(job);
    if (next) nextRun[job.name] = next;
    // No schedule -> nothing to schedule, so drop any stale entry.
    else delete nextRun[job.name];
  }
  const payload = { lastRunAt: nowIso(), counts, nextRun };
  await writeAtomic(STATE_FILE, JSON.stringify(payload, null, 2));
  return { ...state, ...payload };
}

// Map one job result onto an emotion event. Kept here rather than in
// emotion.mjs so the scheduler owns the job vocabulary and emotion.mjs stays
// about states. Like affect's version, the timeout pattern matches the
// spellings this codebase actually emits ("timed out", not "timeout").
function emotionEventFor(entry) {
  if (!entry || !entry.job || entry.skipped) return null;
  if (entry.ok) {
    if (entry.toolCalls > 0) return "task_completed";
    return "milestone_reached";
  }
  const err = String(entry.error ?? "");
  if (/timed?\s*-?\s*out|timeout|ETIMEDOUT|aborted after \d+ms/i.test(err)) return "timed_out";
  if (/no such file|not found|ENOENT/i.test(err)) return "tool_broken";
  if (/differ|contradict/i.test(err)) return "inconsistent_result";
  return "failed";
}

async function runOne(job, state, agentConfig) {
  const systemPrompt = job.kind === "shell" ? null : await loadSystemPrompt(state);
  if (job.kind === "shell") return runShellJob(job, { state });
  // Imported lazily: an agent job pulls in @huggingface/tiny-agents and every
  // MCP server binary, which is slow and pointless for a scheduler that will
  // never fire one.
  if (job.kind === "agent") {
    const { runAgentJob } = await import("./lib/agent.mjs");
    return runAgentJob(job, { agentConfig, systemPrompt, state });
  }
  return runJob(job, { agentConfig, systemPrompt, state });
}

// Persist one job's next firing, leaving every other job's entry alone. Used by
// the resident scheduler, which runs jobs one at a time and has no results
// array to hand to saveRunState.
async function recordNextRun(job) {
  const state = await loadState();
  const nextRun = { ...(state.nextRun || {}) };
  const next = computeNextRun(job);
  if (next) nextRun[job.name] = next;
  else delete nextRun[job.name];
  await writeAtomic(
    STATE_FILE,
    JSON.stringify(
      { lastRunAt: state.lastRunAt, counts: state.counts, nextRun },
      null,
      2
    )
  );
}

// Fire every job whose cron time has passed since the last run. --once is what
// termux-job-scheduler invokes; it must be idempotent and cheap.
async function runDueJobs({ force = false } = {}) {
  const release = await acquireLock(LOCK_FILE);
  if (!release) {
    await appendJsonl(RUN_LOG, {
      job: "(scheduler)",
      startedAt: nowIso(),
      ok: false,
      skipped: "another scheduler holds the lock",
      output: "",
      error: null
    });
    return [];
  }

  try {
    const state = await loadState();
    const agentConfig = await readJson(path.join(REPO_DIR, "agent.json"), {});
    const all = await loadJobs();
    const results = [];
    const fired = [];

    for (const job of all) {
      if (job.enabled === false) continue;

      // A job with no schedule has no "due" time -- it is on-demand only, via
      // `krieger run`. Everything else is due when its persisted nextRun is
      // absent (never fired) or in the past.
      const due = isDue(job, state.nextRun, { force });

      if (!due) continue;

      try {
        results.push(await runOne(job, state, agentConfig));
        fired.push(job);
      } catch (err) {
        results.push({
          job: job.name,
          ok: false,
          error: redact(err?.stack ?? String(err)),
          output: ""
        });
        fired.push(job);
      }
    }

    if (results.length) {
      await saveRunState(state, results, fired);
      // Feed outcomes into the affect priors. Best-effort: a job's result must
      // never be lost because the affect bookkeeping threw, so this is wrapped
      // and failures are swallowed rather than propagated into runDueJobs.
      try {
        const { recordFromJobResult } = await import("./affect.mjs");
        for (const r of results) await recordFromJobResult(r);
        // The wide emotion palette records from the same job outcomes. Separate
        // try/catch so a failure in one cannot stop the other -- these are
        // bookkeeping side-effects and must never cost a job its result.
        try {
          const { record: recordEmotion } = await import("./emotion.mjs");
          for (const r of results) {
            const event = emotionEventFor(r);
            if (event) await recordEmotion(event, { note: `job:${r.job}` });
          }
        } catch (emotionErr) {
          await appendJsonl(RUN_LOG, {
            job: "(emotion)",
            startedAt: nowIso(),
            ok: false,
            output: "",
            error: `emotion bookkeeping failed: ${redact(String(emotionErr?.message ?? emotionErr)).slice(0, 300)}`
          });
        }
      } catch (err) {
        await appendJsonl(RUN_LOG, {
          job: "(affect)",
          startedAt: nowIso(),
          ok: false,
          output: "",
          error: `affect bookkeeping failed: ${redact(String(err?.message ?? err)).slice(0, 300)}`
        });
      }
    }

    return results;
  } finally {
    await release();
  }
}

// ---------------------------------------------------------------------------
// Long-running scheduler mode
// ---------------------------------------------------------------------------

async function serve() {
  const state = await loadState();
  const agentConfig = await readJson(path.join(REPO_DIR, "agent.json"), {});
  const all = await loadJobs();
  const active = all.filter((j) => j.enabled !== false);

  await appendJsonl(RUN_LOG, {
    job: "(scheduler)",
    startedAt: nowIso(),
    ok: true,
    output: `scheduler start: ${active.length} active job(s)`,
    error: null
  });

  for (const job of active) {
    if (!job.schedule) continue;
    try {
      new Cron(job.schedule, { name: job.name, catch: true }, async () => {
        const release = await acquireLock(LOCK_FILE);
        if (!release) return;
        try {
          const liveState = await loadState();
          await runOne(job, liveState, agentConfig);
          // Record the firing so a later `scheduler.mjs --once` (the Android
          // job path) does not immediately re-fire what just ran. Without this
          // the two modes disagree about what has already happened.
          await recordNextRun(job);
        } catch (err) {
          await appendJsonl(RUN_LOG, {
            job: job.name,
            startedAt: nowIso(),
            ok: false,
            error: redact(err?.message ?? String(err)),
            output: ""
          });
        } finally {
          await release();
        }
      });
    } catch (err) {
      await appendJsonl(RUN_LOG, {
        job: job.name,
        startedAt: nowIso(),
        ok: false,
        error: `bad schedule "${job.schedule}": ${err.message}`,
        output: ""
      });
    }
  }

  console.log(`scheduler running: ${active.filter((j) => j.schedule).length} job(s)`);
  process.stdout.write(
    active.map((j) => `  ${String(j.schedule ?? "(none)").padEnd(16)} ${j.name}`).join("\n") + "\n"
  );

  // Keep the event loop alive. With every job disabled -- or croner holding no
  // pending timer -- nothing else holds a handle, so Node exits immediately
  // and start.sh reports a process that vanished. An interval with its ref
  // cleared on SIGTERM/SIGINT is the cheapest way to stay resident.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = (sig) => {
    clearInterval(keepAlive);
    appendJsonl(RUN_LOG, {
      job: "(scheduler)",
      startedAt: nowIso(),
      ok: true,
      output: `scheduler stop (${sig})`,
      error: null
    }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

// Only run the CLI when this file is the entry point. Without this guard,
// importing the scheduler from a test starts a resident daemon and the process
// never exits. Compare resolved paths rather than the argv string so relative
// invocations (`node daemon/scheduler.mjs`) still count as the entry point.
const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!isEntryPoint) {
  // Imported for its pure helpers (isDue, computeNextRun). Nothing to do.
} else if (argv.includes("--dry-run")) {
  const all = await loadJobs();
  console.log(`repo:  ${REPO_DIR}`);
  console.log(`jobs:  ${all.length} defined, ${all.filter((j) => j.enabled !== false).length} enabled\n`);
  for (const j of all) {
    console.log(
      `${j.enabled === false ? "off " : " ON "} ${String(j.schedule ?? "(none)").padEnd(16)} ` +
        `${j.kind.padEnd(5)} ${j.name}`
    );
  }
} else if (argv.includes("--once")) {
  const results = await runDueJobs({ force: argv.includes("--force") });
  if (!results.length) console.log("nothing due");
  for (const r of results) {
    console.log(
      `${r.ok ? "ok  " : r.skipped ? "skip" : "FAIL"} ${r.job} ` +
        `(${(r.durationMs ?? 0) / 1000}s) ${String(r.output ?? r.error ?? "").slice(0, 200)}`
    );
  }
} else {
  await ensureDir(STATE_DIR);
  await serve();
}
