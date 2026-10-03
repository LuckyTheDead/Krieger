// Core helpers for the Krieger unattended daemon.
// No dependencies beyond node builtins (croner is loaded by the scheduler).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DAEMON_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_DIR = path.dirname(DAEMON_DIR);

// Any string matching this is a credential, whatever else claims it is.
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{16,}/g, // openrouter / openai style
  /hf_[a-zA-Z0-9]{20,}/g, // huggingface
  /gh[pousr]_[a-zA-Z0-9]{20,}/g, // github
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,
];

// Anything written to disk or a log goes through here first. The daemon reads
// agent.json, which holds a live key; a stray error dump must not persist it.
export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// Write via temp file + rename so a crash mid-write cannot leave a truncated
// or empty jobs.json / state file behind.
export async function writeAtomic(file, contents) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, file);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw new Error(`${file} is not valid JSON: ${redact(err.message)}`);
  }
}

export async function appendJsonl(file, obj) {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(obj)}\n`);
}

// Exclusive lock so two schedulers (or two termux-job-scheduler firings) cannot
// run the same job concurrently and interleave writes in the run log.
export async function acquireLock(lockFile, { staleMs = 6 * 60 * 60 * 1000 } = {}) {
  await ensureDir(path.dirname(lockFile));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }));
      await handle.close();
      return () => fs.unlink(lockFile).catch(() => {});
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Reap only if the holder is gone or the lock is ancient.
      let stale = false;
      try {
        const raw = JSON.parse(await fs.readFile(lockFile, "utf8"));
        const age = Date.now() - new Date(raw.at).getTime();
        // Signal 0 tests for existence only. ESRCH = the pid is genuinely
        // gone, so reap. EPERM = the pid exists but belongs to another uid
        // (a live scheduler running outside our sandbox, say) -- that is a
        // LIVE holder, not a dead one, and stealing its lock is how two
        // schedulers end up running the same job at once.
        //
        // EINVAL is the Windows case: process.kill(pid, 0) there throws
        // EINVAL, not ESRCH, for a pid that does not exist (there is no pid 1
        // on Windows at all). Treating EINVAL as "alive" meant a lock whose
        // holder is provably dead was never reaped on Windows -- a stale lock
        // that blocks the scheduler forever. EINVAL is not evidence of life,
        // so it is treated as dead, same as ESRCH.
        let alive;
        try {
          process.kill(raw.pid, 0);
          alive = true;
        } catch (killErr) {
          alive = !["ESRCH", "EINVAL"].includes(killErr?.code);
        }
        stale = !alive || age > staleMs;
      } catch {
        stale = true; // unreadable lock
      }
      if (!stale) return null;
      await fs.unlink(lockFile).catch(() => {});
    }
  }
  return null;
}

export function tail(text, max = 4000) {
  const t = redact(String(text ?? ""));
  return t.length > max ? `...[truncated]\n${t.slice(-max)}` : t;
}

export async function resolveApiKey(agentConfig) {
  // Env wins so the key can live outside the repo entirely.
  const fromEnv =
    process.env.OPENROUTER_API_KEY || process.env.KRIEGER_API_KEY || "";
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (agentConfig?.apiKey) return { key: agentConfig.apiKey, source: "agent.json" };
  throw new Error(
    "No API key. Set OPENROUTER_API_KEY in the environment, or put apiKey in agent.json."
  );
}
