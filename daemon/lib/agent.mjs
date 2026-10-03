// Agent-kind jobs: a full tiny-agents tool loop, unattended.
//
// This is the only job kind that can DO something rather than report something.
// The `llm` kind posts a single completion with no tools; `shell` runs a script.
// `agent` constructs the same Agent the interactive CLI builds, hands it one
// prompt, and lets it call MCP tools in a loop until it finishes.
//
// Three device-specific constraints shaped this module. All three were verified
// on this phone rather than assumed:
//
//  1. agent.json stores stdio servers as {type, command, args}, but mcp-client
//     reads server.config.command. Passing the raw shape makes addMcpServer
//     spawn the literal string "undefined" and fail ENOENT, which reads like a
//     missing binary rather than a shape mismatch. Hence buildServers().
//
//  2. mcp-client replaces a child's env with {...server.config.env, PATH}. It
//     does not forward the parent's env, so a key present in the daemon's
//     environment would NOT reach a tool subprocess. Keep that: it is why a
//     self-modifying job cannot read the credential that pays for it.
//
//  3. mcp-server-filesystem and mcp-remote are `#!/usr/bin/env node` scripts
//     and Termux has no /usr/bin/env. The kernel rejects the shebang before
//     exec, so spawning the symlink returns ENOENT even though the file exists
//     and is executable. Hence resolveCommand().

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendJsonl, nowIso, redact, tail } from "./core.mjs";

const REPO_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const NODE_BIN = "/data/data/com.termux/files/usr/bin/node";
const PREFIX = "/data/data/com.termux/files/usr";

const ENV_SHEBANG = "/usr/bin/env";

// Tools that change something. An unattended job can read freely; writing is a
// separate, opt-in decision (job.allowWrite).
//
// shell_exec is deliberately NOT here. It is the one tool that can reach
// outside the repo and outside the memory store, and treating it as "just
// another file write" would understate what it can do. It is gated by its own
// flag below rather than lumped in with filesystem tools.
const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "create_directory",
  "move_file",
  "memory_store",
  "memory_update",
  "memory_forget"
]);

export function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

export function isShellTool(name) {
  return name === "shell_exec";
}

// EGRESS TOOLS -- found by the 2026-10-01 security audit.
//
// The original deny-list only covered writes and shell_exec. That left a
// read-then-exfiltrate path open: an agent job could read a credential with
// read_file and then push it off-device with hf_fs, hub_repo_details, or
// termux_api's clipboard-set. Denying "write" is meaningless if the model can
// still publish what it read somewhere I cannot wipe.
//
// Withheld unless the job sets allowEgress. Note the honest limit: this is not
// a sandbox. The model can still put a secret in its own output text, and that
// text goes to the provider. The real fix for THAT is not holding the secret
// in a file the job can reach -- which is why the credential now lives in
// ~/.secrets.env, outside the filesystem server's root.
const EGRESS_TOOLS = new Set([
  "hf_fs",
  "hf_fs_write",
  "hub_repo_details",
  "clipboard-set",
  "clipboard-get"
]);

export function isEgressTool(name) {
  return EGRESS_TOOLS.has(name);
}

// Files an agent job must never read, by basename. Defence in depth: the
// credential has moved out of the repo already, but this keeps a future
// misplacement from being silently fatal.
const SECRET_FILENAMES = new Set([
  "agent.json",
  ".secrets.env",
  "id_ed25519_krieger",
  "id_ed25519",
  "id_rsa",
  "authorized_keys"
]);

// Patterns that mark a private key whatever it is called. A match on
// _id_ed25519 as a SUFFIX never fires -- id_ed25519_pc ends in _pc, not
// _id_ed25519. The key marker sits in the MIDDLE of these names, so this has to
// be a substring/regex test rather than endsWith.
const SECRET_PATTERNS = [
  /(^|[\\/])id_(ed25519|rsa|ecdsa|dsa)(\b|_|\.)/i,   // id_ed25519, id_ed25519_pc, id_rsa.pub
  /\.(pem|key|p12|pfx|ppk)$/i,                     // server.pem, upload.key, cert.p12
  /(^|[\\/])authorized_keys$/i,
];

function isSecretName(name) {
  if (SECRET_FILENAMES.has(name)) return true;
  return SECRET_PATTERNS.some((re) => re.test(name));
}

export function isSecretFile(filename) {
  // Split on BOTH separators explicitly, not with path.basename: basename is
  // platform-dependent, so it handles a Windows path correctly only ON Windows
  // and returns the whole string on Linux. That produced two different bugs --
  // split("/") broke the Windows host, path.basename broke the phone. A log can
  // contain paths from either machine, so the check must not care which.
  const base = String(filename ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  return isSecretName(base);
}

// A `#!/usr/bin/env node` script cannot be spawned on Termux. Re-point it at
// the interpreter with the script as argv[1]. Returns null when the command is
// fine as-is, so a normal binary passes through untouched.
export async function resolveCommand(command, args = []) {
  const raw = String(command ?? "");
  if (!raw.startsWith(`${PREFIX}/bin/`)) return null;
  let head;
  try {
    const fh = await fs.open(raw, "r");
    try {
      const buf = Buffer.alloc(128);
      const { bytesRead } = await fh.read(buf, 0, 128, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null; // unreadable/missing: let the spawn report it
  }
  const first = head.split("\n", 1)[0] ?? "";
  if (!first.startsWith("#!") || !first.includes(ENV_SHEBANG)) return null;
  return {
    command: NODE_BIN,
    args: [raw, ...(Array.isArray(args) ? args : [])]
  };
}

// agent.json's raw {type, command, args} -> mcp-client's {type, config: {...}}.
export async function buildServers(servers) {
  if (!Array.isArray(servers)) return [];
  const out = [];
  for (const s of servers) {
    if (s?.type !== "stdio") continue;
    let command = s.command;
    let args = Array.isArray(s.args) ? [...s.args] : [];
    const fixed = await resolveCommand(command, args);
    if (fixed) {
      command = fixed.command;
      args = fixed.args;
    }
    out.push({
      type: "stdio",
      config: { command, args, env: {}, cwd: REPO_DIR }
    });
  }
  return out;
}

// mcp-client hands every tool result back as a `tool` chunk, which is how the
// runner tells "thought about it" from "actually called something".
export function isToolChunk(chunk) {
  return Boolean(chunk && typeof chunk === "object" && chunk.role === "tool");
}

// ENFORCEMENT NOTE -- read before trusting any post-hoc check.
//
// mcp-client executes a tool call inside processSingleTurnWithTools, via
// client.callTool(), and only *then* yields the result as a `tool` chunk. So a
// check placed after that yield observes what happened; it cannot prevent it.
// Inspecting chunks is therefore NOT a permission system.
//
// The lever that actually works is what the model is offered: Agent.run() passes
// agent.availableTools to the endpoint as the `tools` array. Removing an entry
// there means the model is never told the tool exists. Belt and braces, the
// same names are also struck from the name->server map, because mcp-client
// resolves an unexpected tool call by name and would otherwise still route it
// to a live server -- and write_file is a name this model has very likely seen
// in training, so "it was never offered" is not by itself sufficient.
//
// Returns the names it removed. `clients` is a TS-private field, so this leans
// on the bundled runtime shape; if mcp-client is upgraded, verify both arrays
// still exist before trusting this to deny anything.
export function applyToolPolicy(
  agent,
  { allowWrite = false, allowShell = false, allowEgress = false } = {}
) {
  const removed = [];
  const blocked = (name) => {
    // Three independent permissions. None implies another: publishing what you
    // read is a separate capability from writing it or running it.
    if (isEgressTool(name)) return !allowEgress;
    if (isShellTool(name)) return !allowShell;
    if (isWriteTool(name)) return !allowWrite;
    return false;
  };

  agent.availableTools = agent.availableTools.filter((t) => {
    const name = t?.function?.name ?? "";
    if (!blocked(name)) return true;
    removed.push(name);
    return false;
  });

  const clients = agent.clients;
  if (clients instanceof Map) {
    for (const name of [...clients.keys()]) {
      if (blocked(name)) clients.delete(name);
    }
  }
  return removed;
}

// Agent.run() only stops early when the model reaches for task_complete. The
// model has no way to know that tool exists unless told, so without this the
// loop runs to MAX_NUM_TURNS and ends on planning text with no conclusion.
export const META_TOOL_NOTE = `

Harness tools already available to you (do not re-describe them):
- task_complete(trigger: boolean) -- call this as your FINAL action once the work is done.
- ask_question(trigger: boolean) -- a scheduled run has nobody to answer, so decide rather than ask.
`;

// Connect servers ONE AT A TIME onto the given agent, not all at once.
//
// Agent.loadTools() calls addMcpServers(), which is Promise.all over every
// server. On this phone that reliably kills mcp-remote: with six node MCP
// servers starting simultaneously, it dies partway through `initialize`
// ("Connection closed") while the other five come up fine. Started on its own it
// connects in ~4s and serves 4 tools. So the failure is contention, not a bad
// config.
//
// Connecting in series costs a few seconds and removes the flakiness. It also
// means one dead server no longer takes the whole job down: each failure is
// recorded and the job proceeds with whatever did connect, which is what you
// want from a self-review job -- a missing HF server should not stop it reading
// the repo.
//
// Returns [{label, ok, error?}]. No tool filtering happens here; applyToolPolicy
// runs afterwards, on the finished tool list.
export async function connectServers(agent, servers) {
  const results = [];
  for (const server of servers) {
    // Split on both separators, not split("/") and not path.basename.
    // split("/") finds no forward slash in a C:\... path, so .pop() returned
    // the entire absolute path and serversConnected/serversFailed were filled
    // with full paths instead of labels. path.basename fixes that on Windows but
    // breaks on Linux for the same paths, and a log can carry either. Found by
    // the self-review job running on the PC.
    const label = String(server.config.args[0] ?? "").split(/[\\/]/).filter(Boolean).pop()
      || server.config.command;
    try {
      await agent.addMcpServer(server);
      results.push({ label, ok: true });
    } catch (err) {
      results.push({ label, ok: false, error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return results;
}

export async function runAgentJob(job, { agentConfig, systemPrompt, state } = {}) {
  const startedAt = nowIso();
  const t0 = Date.now();

  const entry = {
    job: job.name,
    kind: "agent",
    startedAt,
    ok: false,
    durationMs: 0,
    output: "",
    error: null,
    skipped: null,
    toolCalls: 0,
    toolNames: []
  };

  const runLog = state?.runLog;
  const persist = async () => {
    if (runLog) await appendJsonl(runLog, entry);
  };

  let agent;
  try {
    if (job.enabled === false) {
      entry.skipped = "disabled";
      entry.durationMs = Date.now() - t0;
      await persist();
      return entry;
    }

    const prompt = String(job.prompt ?? "").trim();
    if (!prompt) throw new Error(`job ${job.name} has no prompt`);

    const key = process.env.OPENROUTER_API_KEY || agentConfig?.apiKey || "";
    if (!key) {
      throw new Error(
        "No API key. Set OPENROUTER_API_KEY in the environment, or set apiKey in agent.json."
      );
    }
    if (!agentConfig?.model || !agentConfig?.endpointUrl) {
      throw new Error("agent.json must set both model and endpointUrl.");
    }

    const servers = await buildServers(agentConfig.servers);
    if (!servers.length) {
      throw new Error("agent.json defines no usable stdio servers for an agent job.");
    }

    const { Agent } = await import("@huggingface/tiny-agents");
    agent = new Agent({
      endpointUrl: agentConfig.endpointUrl,
      model: agentConfig.model,
      apiKey: key,
      // Empty on purpose: servers are attached one at a time below so a single
      // contended server cannot abort the whole load.
      servers: [],
      prompt: systemPrompt || undefined
    });

    const connected = await connectServers(agent, servers);
    entry.serversConnected = connected.filter((c) => c.ok).map((c) => c.label);
    const failedServers = connected.filter((c) => !c.ok);
    if (failedServers.length) {
      entry.serversFailed = failedServers.map((c) => `${c.label}: ${c.error}`);
    }

    // REQUIRED, and easy to miss: the Agent constructor connects to nothing, and
    // availableTools stays empty until a server registers tools. With an empty
    // list the model is offered only the two harness meta-tools and the job
    // "succeeds" while being structurally incapable of doing its work. The first
    // live run of self-review did exactly that and returned a confident, entirely
    // fictional absence-of-findings -- so it now fails loudly instead.
    if (!agent.availableTools.length) {
      throw new Error(
        "no MCP tools connected: an agent job with no tools cannot do its work. " +
          "See entry.serversFailed for per-server detail, or check the shebang " +
          "handling in resolveCommand()."
      );
    }
    entry.toolsOffered = agent.availableTools.length;

    const controller = new AbortController();
    const budgetMs = Number(job.timeoutMs ?? 300000);
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const onAbort = () => {};
    controller.signal.addEventListener("abort", onAbort);

    // Remove the tools this job may not use BEFORE the first model call, so the
    // model is never offered them. Anything checked later is observation only.
    const removed = applyToolPolicy(agent, {
      allowWrite: job.allowWrite === true,
      allowShell: job.allowShell === true,
      allowEgress: job.allowEgress === true
    });
    if (removed.length) entry.toolsRemoved = removed;
    entry.toolsAvailable = agent.availableTools.length;

    let text = "";
    const names = new Set();

    try {
      for await (const chunk of agent.run(prompt + META_TOOL_NOTE, {
        abortSignal: controller.signal
      })) {
        const delta = chunk?.choices?.[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          continue;
        }
        if (!isToolChunk(chunk)) continue;
        const name = String(chunk.name ?? "");
        entry.toolCalls++;
        // A name here that was stripped above means the model called a tool it
        // was never offered. mcp-client answers those with "No session found",
        // so nothing executed -- but it is worth recording, because it means the
        // policy was challenged.
        if (removed.includes(name)) entry.policyChallenges = (entry.policyChallenges ?? 0) + 1;
        names.add(name);
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }

    if (controller.signal.aborted) {
      entry.error = `aborted after ${budgetMs}ms (timeout budget)`;
      entry.durationMs = Date.now() - t0;
      await persist();
      return entry;
    }

    if (!text.trim()) {
      entry.error =
        entry.toolCalls > 0
          ? `no assistant text; the model made ${entry.toolCalls} tool call(s) and said nothing`
          : "no assistant text and no tool calls: empty completion";
      entry.toolNames = [...names];
      entry.durationMs = Date.now() - t0;
      await persist();
      return entry;
    }

    entry.ok = true;
    entry.output = tail(text, 6000);
    entry.toolNames = [...names];
    entry.durationMs = Date.now() - t0;
    await persist();
    return entry;
  } catch (err) {
    entry.error = tail(redact(err?.stack ?? String(err)), 2500);
    entry.durationMs = Date.now() - t0;
    await persist();
    return entry;
  } finally {
    // cleanup() closes every stdio MCP subprocess. Skipping it leaks one node
    // process per server per firing, twelve times a day.
    if (agent) {
      try {
        await agent.cleanup();
      } catch (err) {
        entry.cleanupError = tail(redact(err?.message ?? String(err)), 300);
      }
    }
  }
}