// Context assembly for unattended runs.
//
// The daemon does NOT talk to the memory MCP over stdio (a subprocess per run
// is fragile and risks recursion). It imports the MCP module directly and calls
// its own loadLog/searchMemories, so an unattended call sees exactly what an
// interactive session would see -- same log, same folding, same ranking.
//
// Safe to import: memory-mcp.js only starts listening when invoked directly.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";

import { tail } from "./core.mjs";

const REPO_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// pathToFileURL, not the bare path: a Windows absolute path is parsed as a URL
// with scheme "c:" and the ESM loader rejects it with
// ERR_UNSUPPORTED_ESM_URL_SCHEME. Identical on Linux, so this only ever broke
// on Windows -- found by running the suite there.
const memoryMcp = await import(
  pathToFileURL(path.join(REPO_DIR, "termux-mcp", "memory-mcp.js")).href
);

const MAX_CONTEXT_CHARS = 3000;

export async function recallContext(job, { state } = {}) {
  const parts = [];

  // 1. Prior runs of this job — the most useful signal for self-monitoring.
  const priorRuns = await recentRunsFor(state, job.name, 3);
  if (priorRuns.length) {
    const lines = priorRuns
      .map((r) => {
        const status = r.ok
          ? "ok"
          : r.skipped
            ? `skipped(${r.skipped})`
            : `failed: ${String(r.error).replace(/\s+/g, " ").slice(0, 200)}`;
        const body = r.ok
          ? ` -> ${String(r.output).replace(/\s+/g, " ").slice(0, 180)}`
          : "";
        return `  ${r.startedAt}: ${status}${body}`;
      })
      .join("\n");
    parts.push(`Previous runs of "${job.name}":\n${lines}`);
  }

  if (job.kind === "shell") return parts.length ? tail(parts.join("\n\n"), MAX_CONTEXT_CHARS) : null;

  // 2. Memories tagged for this job — deliberate, high-precision signal.
  if (job.memoryTags?.length) {
    const found = await searchMemories(job.memoryTags.join(" "), 5);
    const block = formatMemoryBlock("Tagged memories", found, 240);
    if (block) parts.push(block);
  }

  // 3. Free-text search on the prompt itself.
  if (job.memorySearch !== false && (job.prompt?.length ?? 0) > 40) {
    const found = await searchMemories(job.prompt, 4);
    const block = formatMemoryBlock(`Memory search on prompt`, found, 200);
    if (block) parts.push(block);
  }

  if (!parts.length) return null;
  return tail(parts.join("\n\n"), MAX_CONTEXT_CHARS);
}

// searchMemories returns { memory, score, ... }, not the memory itself. Read
// through .memory or this prints `undefined` for every hit.
function formatMemoryBlock(label, results, width) {
  const lines = results
    .map((r) => {
      const m = r?.memory;
      if (!m?.id) return null;
      return `  [${String(m.id).slice(0, 8)}] ${String(m.content ?? "").slice(0, width)}`;
    })
    .filter(Boolean)
    .join("\n");
  return lines ? `${label}:\n${lines}` : null;
}

async function searchMemories(query, limit) {
  try {
    const { memories, warnings } = await memoryMcp.loadLog();
    const results = memoryMcp.searchMemories(memories, query, limit);
    return results; // warnings are surfaced via the run log, not the prompt
  } catch {
    // A memory read failure must not sink an unrelated job.
    return [];
  }
}

async function recentRunsFor(state, name, n) {
  if (!state?.runLog) return [];
  try {
    const raw = await fs.readFile(state.runLog, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean).slice(-400);
    const out = [];
    for (const line of lines.reverse()) {
      try {
        const e = JSON.parse(line);
        if (e.job === name) out.push(e);
        if (out.length >= n) break;
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}
