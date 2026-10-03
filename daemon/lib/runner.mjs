// Executes a single job: renders its prompt, calls the endpoint, writes the
// result to the run log, and optionally fires a notification.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  appendJsonl,
  nowIso,
  redact,
  resolveApiKey,
  tail
} from "./core.mjs";
import { chat } from "./llm.mjs";
import { recallContext } from "./memory.mjs";

const execFileAsync = promisify(execFile);

// A job command is POSIX shell by design (`echo a; exit 3`,
// `${VAR:-unset}`), so it must run under a shell rather than being exec'd
// directly. The binary was hardcoded to Termux's path, which meant every
// `shell` job on any other host died with a bare ENOENT -- indistinguishable
// from a bad command. Resolve it at call time and report clearly when there is
// no shell, rather than failing as ENOENT.
function shellBinary() {
  if (process.platform === "win32") {
    // Git for Windows ships a real bash next to git.exe; probe for it instead
    // of assuming a location.
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      `${process.env.USERPROFILE || ""}\\tools\\git\\bin\\bash.exe`,
    ];
    for (const p of candidates) if (p && fsSync.existsSync(p)) return p;
    return null;
  }
  return "/data/data/com.termux/files/usr/bin/bash";
}

export async function runJob(job, { agentConfig, systemPrompt, state }) {
  const startedAt = nowIso();
  const t0 = Date.now();

  // Never let a job inherit credentials the caller did not intend to hand it.
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.KRIEGER_API_KEY;
  delete env.HF_TOKEN;
  delete env.HUGGINGFACE_TOKEN;

  let entry = {
    job: job.name,
    startedAt,
    ok: false,
    durationMs: 0,
    output: "",
    error: null,
    skipped: null
  };

  try {
    if (job.enabled === false) {
      entry.skipped = "disabled";
      entry.durationMs = Date.now() - t0;
      await appendJsonl(state.runLog, entry);
      return entry;
    }

    const { key, source } = await resolveApiKey(agentConfig);
    entry.keySource = source;

    const context = await recallContext(job, { state });

    const userMessage = context
      ? `${job.prompt}\n\n---\nRecent context from memory and prior runs:\n${context}`
      : job.prompt;

    const result = await chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      {
        endpointUrl: agentConfig.endpointUrl,
        apiKey: key,
        model: agentConfig.model,
        signal: job.signal
      }
    );

    entry.ok = true;
    entry.output = tail(result.content, 6000);
    entry.usage = result.usage;
    entry.model = result.model;
    entry.durationMs = Date.now() - t0;
  } catch (err) {
    const aborted =
      err?.name === "AbortError" || /abort/i.test(err?.message ?? "");
    entry.error = tail(
      aborted ? `aborted: ${redact(err.message)}` : redact(err?.stack ?? String(err)),
      2500
    );
    entry.aborted = aborted;
    entry.durationMs = Date.now() - t0;
  }

  if (job.notify && entry.ok) {
    try {
      await notify(entry, job);
    } catch (err) {
      entry.notifyError = tail(redact(err?.message ?? String(err)), 300);
    }
  }

  await appendJsonl(state.runLog, entry);
  return entry;
}

// Notifications go through Termux:API, which is ANDROID-ONLY -- there is no
// termux-notification on any other host. Resolve it at call time and say so,
// rather than raising a bare ENOENT that reads like a broken job. The caller
// catches and records this as notifyError, so a host without Termux simply
// never notifies.
function notificationBinary() {
  const override = process.env.TERMUX_NOTIFY_BIN;
  const candidates = [
    override,
    "/data/data/com.termux/files/usr/bin/termux-notification",
  ].filter(Boolean);
  for (const c of candidates) if (fsSync.existsSync(c)) return c;
  return null;
}

async function notify(entry, job) {
  const bin = notificationBinary();
  if (!bin) {
    throw new Error(
      "no notification binary: termux-notification is part of Termux:API and " +
        "only exists on Android; set TERMUX_NOTIFY_BIN to override",
    );
  }

  const body = (job.notifyMessage || entry.output || "job finished")
    .split("\n")
    .slice(0, 4)
    .join("\n")
    .slice(0, 300);

  await execFileAsync(
    bin,
    [
      "-t",
      `krieger: ${job.name}`,
      "-c",
      body,
      "-p",
      "do-not-disturb"
    ],
    { timeout: 10000 }
  );
}

// shell jobs bypass the LLM entirely: a scheduled health check has no business
// costing a model call.
export async function runShellJob(job, { state }) {
  const startedAt = nowIso();
  const t0 = Date.now();

  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.KRIEGER_API_KEY;
  delete env.HF_TOKEN;
  delete env.HUGGINGFACE_TOKEN;

  const entry = {
    job: job.name,
    kind: "shell",
    startedAt,
    ok: false,
    durationMs: 0,
    output: "",
    error: null
  };

  try {
    if (job.enabled === false) {
      entry.skipped = "disabled";
      entry.durationMs = Date.now() - t0;
      await appendJsonl(state.runLog, entry);
      return entry;
    }

    // A job command is POSIX shell by design (`echo a; exit 3`,
    // `${VAR:-unset}`), so run it under a shell rather than exec'ing the
    // command directly. The binary was hardcoded to Termux's path, which meant
    // every `shell` job on any other host died with a bare ENOENT --
    // indistinguishable from a bad command. Resolve it at call time.
    const shell = shellBinary();
    if (!shell) {
      throw new Error(
        "no POSIX shell found: install Git for Windows (it ships bash.exe); " +
          "`shell` jobs need bash to run",
      );
    }

    const { stdout, stderr } = await execFileAsync(
      shell,
      ["-lc", job.command],
      {
        cwd: job.cwd || state.repoDir,
        timeout: job.timeoutMs ?? 120000,
        maxBuffer: 4 * 1024 * 1024,
        env
      }
    );
    entry.ok = true;
    entry.output = tail(stdout, 6000);
    if (stderr) entry.stderr = tail(stderr, 2000);
  } catch (err) {
    // execFile throws on non-zero exit but carries the output on it.
    entry.error = tail(
      redact(`exit ${err.code ?? "?"}: ${err.stderr || err.message}`),
      2500
    );
    if (err.stdout) entry.output = tail(err.stdout, 4000);
    entry.durationMs = Date.now() - t0;
    await appendJsonl(state.runLog, entry);
    return entry;
  }

  entry.durationMs = Date.now() - t0;

  if (job.notify && entry.ok) {
    try {
      await notify(entry, job);
    } catch (err) {
      entry.notifyError = tail(redact(err?.message ?? String(err)), 300);
    }
  }

  await appendJsonl(state.runLog, entry);
  return entry;
}

export async function loadSystemPrompt(state) {
  // PROMPT.md is the source of truth (see the prompt-sync guard). If it is
  // missing or has drifted from the copy, fail loudly instead of running a
  // session on a persona that no longer matches the repo.
  const promptFile = path.join(state.repoDir, "PROMPT.md");
  let prompt;
  try {
    prompt = await fs.readFile(promptFile, "utf8");
  } catch {
    prompt = await fs.readFile(path.join(state.repoDir, "personality", "system-prompt.txt"), "utf8");
  }

  const copy = path.join(state.repoDir, "personality", "system-prompt.txt");
  try {
    const other = await fs.readFile(copy, "utf8");
    if (other !== prompt) {
      throw new Error(
        "PROMPT.md and personality/system-prompt.txt differ. Run: npm run test:prompt"
      );
    }
  } catch (err) {
    if (!/ENOENT/.test(err?.code ?? "")) throw err;
  }

  return prompt;
}
