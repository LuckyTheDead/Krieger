/**
 * Tests for the `agent` job kind.
 *
 * Scope note: these tests cover everything that does NOT need a live model
 * call. The tool loop itself is exercised by `npm run demo:agent` (a real
 * one-shot run) rather than here, because a unit test that silently started
 * billing real tokens every `npm test` would be a bad trade.
 *
 * The behaviours worth locking down are the ones that failed during the build:
 * the server-shape mismatch, the Termux shebang problem, and the fact that a
 * permission check placed after the tool yield does not actually deny anything.
 *
 * Run: node --test daemon/agent.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyToolPolicy,
  buildServers,
  connectServers,
  isEgressTool,
  isSecretFile,
  isShellTool,
  isToolChunk,
  isWriteTool,
  resolveCommand
} from "./lib/agent.mjs";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "krieger-agent-"));
const NODE_BIN = "/data/data/com.termux/files/usr/bin/node";

// --- tool classification ---------------------------------------------------

test("write tools and the shell tool are classified as mutating", () => {
  for (const n of ["write_file", "edit_file", "move_file", "memory_store"]) {
    assert.equal(isWriteTool(n), true, `${n} should be a write tool`);
  }
  assert.equal(isShellTool("shell_exec"), true);
  assert.equal(isShellTool("read_file"), false);
  assert.equal(isWriteTool("read_file"), false);
  assert.equal(isWriteTool("memory_search"), false, "search is read-only");
});

test("isToolChunk distinguishes a tool result from a stream chunk", () => {
  assert.equal(isToolChunk({ role: "tool", name: "read_file" }), true);
  assert.equal(isToolChunk({ choices: [{ delta: { content: "hi" } }] }), false);
  assert.equal(isToolChunk(null), false);
  assert.equal(isToolChunk("tool"), false);
});

// --- tool policy -----------------------------------------------------------

function fakeAgent(toolNames) {
  const clients = new Map(toolNames.map((n) => [n, { name: n }]));
  return {
    availableTools: toolNames.map((n) => ({
      type: "function",
      function: { name: n, description: "", parameters: {} }
    })),
    clients
  };
}

test("policy strips write tools by default and reports what it removed", () => {
  const agent = fakeAgent(["read_file", "write_file", "shell_exec", "memory_search"]);
  const removed = applyToolPolicy(agent);
  assert.deepEqual(removed.sort(), ["shell_exec", "write_file"]);
  const kept = agent.availableTools.map((t) => t.function.name);
  assert.deepEqual(kept.sort(), ["memory_search", "read_file"]);
});

test("policy also unroutes removed tools from the client map", () => {
  // mcp-client resolves a tool call by name against this map. Leaving
  // write_file in here means a model that hallucinated the call would still
  // reach a live server, which is exactly what the policy is meant to stop.
  const agent = fakeAgent(["read_file", "write_file"]);
  applyToolPolicy(agent);
  assert.equal(agent.clients.has("write_file"), false);
  assert.equal(agent.clients.has("read_file"), true);
});

test("allowWrite permits filesystem writes but still withholds shell_exec", () => {
  const agent = fakeAgent(["write_file", "shell_exec"]);
  const removed = applyToolPolicy(agent, { allowWrite: true });
  assert.deepEqual(removed, ["shell_exec"]);
  assert.deepEqual(agent.availableTools.map((t) => t.function.name), ["write_file"]);
});

test("allowShell alone permits shell_exec but still withholds write_file", () => {
  // The two flags are independent on purpose: running commands and editing
  // files are different permissions and granting one must not imply the other.
  const agent = fakeAgent(["write_file", "shell_exec"]);
  const removed = applyToolPolicy(agent, { allowShell: true });
  assert.deepEqual(removed, ["write_file"]);
  assert.deepEqual(agent.availableTools.map((t) => t.function.name), ["shell_exec"]);
});

test("granting both removes nothing", () => {
  const agent = fakeAgent(["write_file", "shell_exec", "read_file"]);
  assert.deepEqual(applyToolPolicy(agent, { allowWrite: true, allowShell: true }), []);
  assert.equal(agent.availableTools.length, 3);
});

// --- egress policy (added by the 2026-10-01 security audit) ---------------

test("egress tools are classified separately from writes and shell", () => {
  assert.equal(isEgressTool("hf_fs"), true);
  assert.equal(isEgressTool("hf_fs_write"), true);
  assert.equal(isEgressTool("hub_repo_details"), true);
  assert.equal(isEgressTool("clipboard-set"), true);
  // Reading the repo is not egress.
  assert.equal(isEgressTool("read_file"), false);
  assert.equal(isEgressTool("memory_search"), false);
  // A write tool is not automatically an egress tool.
  assert.equal(isEgressTool("write_file"), false);
});

test("a default job cannot publish what it reads", () => {
  // The gap the audit found: the deny-list covered writes and shell_exec, so a
  // job could read a credential and then push it off-device. Denying writes is
  // meaningless if the model can still exfiltrate the bytes.
  const agent = fakeAgent(["read_file", "hf_fs", "hub_repo_details", "write_file"]);
  const removed = applyToolPolicy(agent);
  assert.ok(removed.includes("hf_fs"), "hf_fs must be withheld");
  assert.ok(removed.includes("hub_repo_details"));
  assert.deepEqual(agent.availableTools.map((t) => t.function.name), ["read_file"]);
});

test("allowEgress is independent of allowWrite and allowShell", () => {
  // Granting egress must not imply write, and granting write must not imply
  // egress -- otherwise allowWrite silently becomes "publish anything".
  const a = fakeAgent(["hf_fs", "write_file"]);
  assert.deepEqual(
    applyToolPolicy(a, { allowWrite: true }).sort(),
    ["hf_fs"],
    "allowWrite must not grant egress"
  );
  const b = fakeAgent(["hf_fs", "write_file"]);
  assert.deepEqual(
    applyToolPolicy(b, { allowEgress: true }).sort(),
    ["write_file"],
    "allowEgress must not grant write"
  );
});

test("egress tools are also unrouted from the client map", () => {
  const agent = fakeAgent(["hf_fs", "read_file"]);
  applyToolPolicy(agent);
  assert.equal(agent.clients.has("hf_fs"), false);
});

test("secret filenames are recognised by basename", () => {
  assert.equal(isSecretFile("agent.json"), true);
  assert.equal(isSecretFile("/data/data/com.termux/files/home/.secrets.env"), true);
  assert.equal(isSecretFile("deep/nested/path/id_ed25519_krieger"), true);
  // Windows separators. These all FAILED before: split("/") found no forward
  // slash in a C:\... path, returned the whole string, and none of those
  // strings are in SECRET_FILENAMES -- so a secret file on Windows was treated
  // as ordinary output. Found by the self-review job running on the PC.
  assert.equal(isSecretFile("C:\\Users\\Lucky\\.ssh\\id_ed25519"), true,
    "a Windows path to a key file must be recognised as a secret");
  assert.equal(isSecretFile("C:\\Users\\Lucky\\agent.json"), true);
  assert.equal(isSecretFile("C:\\Users\\Lucky\\project\\README.md"), false,
    "a Windows path to an ordinary file must NOT be flagged");
  // Not only the names this machine happens to use. A private key called
  // id_ed25519_pc or server.pem is still a private key.
  assert.equal(isSecretFile("C:\\Users\\Lucky\\.ssh\\id_ed25519_pc"), true);
  assert.equal(isSecretFile("/home/me/.ssh/server.pem"), true);
  assert.equal(isSecretFile("/home/me/.ssh/id_ed25519_lucky"), true);
  assert.equal(isSecretFile("/home/me/project/README.md"), false);
  assert.equal(isSecretFile("/home/me/src/keystrokes.js"), false,
    "a .js file that merely mentions keys is not a key");
  assert.equal(isSecretFile("package.json"), false);
  assert.equal(isSecretFile("README.md"), false);
  assert.equal(isSecretFile(""), false);
  assert.equal(isSecretFile(undefined), false);
});

test("the credential is not reachable from the filesystem server root", async () => {
  // The fix that actually matters. The filesystem MCP server is rooted at the
  // repo, so a key file placed there is readable by any agent job. Assert the
  // key is NOT inside the repo, so the read path is closed by construction
  // rather than by a deny-list.
  const fsSync = await import("node:fs");
  const repo = path.resolve(import.meta.dirname, "..");
  const agentCfg = path.join(repo, "agent.json");
  if (fsSync.existsSync(agentCfg)) {
    const cfg = JSON.parse(fsSync.readFileSync(agentCfg, "utf8"));
    assert.equal(
      cfg.apiKey,
      undefined,
      "agent.json must not contain apiKey: the filesystem server root is the repo, " +
        "so anything here is readable by an agent job"
    );
  }
});

test("policy tolerates a client map that is absent or the wrong type", () => {
  // `clients` is a TS-private field on McpClient. If a future mcp-client
  // renames it, applyToolPolicy must not throw and take the whole job down.
  const agent = { availableTools: [{ type: "function", function: { name: "write_file" } }] };
  assert.deepEqual(applyToolPolicy(agent), ["write_file"]);
  assert.equal(agent.availableTools.length, 0);
});

// --- Termux shebang handling ------------------------------------------------

test("a /usr/bin/env script is re-pointed at the node interpreter", async () => {
  // The whole reason this module exists in part: Termux has no /usr/bin/env, so
  // spawning the symlink fails ENOENT at the kernel's shebang step even though
  // the target exists and is executable.
  const dir = await tmp();
  const fake = path.join(dir, "mcp-remote");
  await fs.writeFile(fake, "#!/usr/bin/env node\nconsole.log('hi');\n", { mode: 0o755 });
  // Pretend it lives in $PREFIX/bin so the prefix guard passes.
  const asIf = fake.replace(tmp() + "/", "/data/data/com.termux/files/usr/bin/");
  void asIf;

  // resolveCommand only inspects commands under $PREFIX/bin, so exercise the
  // real one against a real prefix binary with an env shebang.
  //
  // This is Termux-specific by construction: the whole point of resolveCommand
  // is that Termux has no /usr/bin/env for the kernel to find. On Windows the
  // prefix does not exist, so there is nothing to rewrite and the assertion
  // below would be testing an absent fixture rather than the code. Skip it
  // there instead of asserting a Termux path that cannot resolve.
  if (process.platform === "win32") {
    assert.equal(
      await resolveCommand("/data/data/com.termux/files/usr/bin/mcp-server-filesystem", []),
      null,
      "no Termux prefix on Windows, so nothing should be rewritten",
    );
    return;
  }

  const real = await resolveCommand(
    "/data/data/com.termux/files/usr/bin/mcp-server-filesystem",
    ["/data/data/com.termux/files/home/tiny-agent"]
  );
  assert.ok(real, "mcp-server-filesystem ships an /usr/bin/env shebang and must be rewritten");
  assert.equal(real.command, NODE_BIN);
  assert.equal(real.args[0], "/data/data/com.termux/files/usr/bin/mcp-server-filesystem");
  assert.deepEqual(real.args.slice(1), ["/data/data/com.termux/files/home/tiny-agent"]);
});

test("a command outside $PREFIX/bin is left alone", async () => {
  // Guard against rewriting something we do not understand.
  assert.equal(await resolveCommand("/usr/local/bin/some-mcp", ["x"]), null);
  assert.equal(await resolveCommand("", []), null);
  assert.equal(await resolveCommand(undefined, []), null);
});

test("a missing binary is passed through so the spawn reports it", async () => {
  assert.equal(
    await resolveCommand("/data/data/com.termux/files/usr/bin/definitely-not-here", []),
    null
  );
});

// --- server shape ----------------------------------------------------------

test("buildServers converts agent.json shape into mcp-client shape", async () => {
  const servers = await buildServers([
    { type: "stdio", command: "/data/data/com.termux/files/usr/bin/mcp-remote", args: ["https://huggingface.co/mcp"] }
  ]);
  assert.equal(servers.length, 1);
  // mcp-client reads server.config.command. Passing the raw {type, command}
  // object makes it spawn the string "undefined" -> ENOENT, which reads as a
  // missing binary rather than a shape mismatch. This is the guard against it.
  //
  // The env-shebang rewrite only applies to commands under the Termux prefix.
  // On Windows that prefix does not exist, so the command must be passed
  // through unchanged -- assert that rather than the Termux rewrite.
  if (process.platform === "win32") {
    assert.equal(
      servers[0].config.command,
      "/data/data/com.termux/files/usr/bin/mcp-remote",
      "no Termux prefix on Windows, so the command is passed through",
    );
  } else {
    assert.equal(servers[0].config.command, NODE_BIN, "env-shebang binary rewritten");
  }
  // The env-shebang rewrite prepends the interpreter on Termux, so args keeps
  // the script path. On Windows there is no prefix to rewrite, so no node is
  // prepended and the original args pass through untouched.
  if (process.platform === "win32") {
    assert.deepEqual(servers[0].config.args, [
      "https://huggingface.co/mcp"
    ]);
  } else {
    assert.deepEqual(servers[0].config.args, [
      "/data/data/com.termux/files/usr/bin/mcp-remote",
      "https://huggingface.co/mcp"
    ]);
  }
});

test("buildServers leaves a plain node server untouched", async () => {
  const servers = await buildServers([
    { type: "stdio", command: NODE_BIN, args: ["/x/memory-mcp.js"] }
  ]);
  assert.equal(servers[0].config.command, NODE_BIN);
  assert.deepEqual(servers[0].config.args, ["/x/memory-mcp.js"]);
});

test("buildServers defaults missing args to an empty array", async () => {
  const servers = await buildServers([{ type: "stdio", command: NODE_BIN }]);
  assert.deepEqual(servers[0].config.args, []);
});

test("buildServers drops non-stdio servers and junk input", async () => {
  assert.deepEqual(await buildServers([{ type: "http", url: "https://x" }]), []);
  assert.deepEqual(await buildServers([]), []);
  assert.deepEqual(await buildServers(null), []);
  assert.deepEqual(await buildServers(undefined), []);
  assert.deepEqual(await buildServers([null, "nope", 42]), []);
});

test("buildServers sets cwd to the repo so relative paths resolve", async () => {
  const servers = await buildServers([{ type: "stdio", command: NODE_BIN }]);
  assert.equal(servers[0].config.cwd, path.resolve(import.meta.dirname, ".."));
});

// --- connectServers --------------------------------------------------------

test("connectServers reports each server and does not abort on the first failure", async () => {
  // The whole reason this exists: Promise.all over all servers kills mcp-remote
  // on this device. A single bad server must not stop the others registering,
  // or a flaky HF server stops the job from reading the repo.
  const agent = {
    availableTools: [],
    seen: [],
    async addMcpServer(server) {
      const label = server.config.args[0] ?? "x";
      this.seen.push(label);
      if (label === "boom") throw new Error("Connection closed");
      this.availableTools.push({ type: "function", function: { name: label } });
    }
  };
  const servers = [
    { type: "stdio", config: { command: NODE_BIN, args: ["ok1"], env: {}, cwd: "." } },
    { type: "stdio", config: { command: NODE_BIN, args: ["boom"], env: {}, cwd: "." } },
    { type: "stdio", config: { command: NODE_BIN, args: ["ok2"], env: {}, cwd: "." } }
  ];
  const results = await connectServers(agent, servers);

  assert.equal(results.length, 3, "every server must be attempted");
  assert.deepEqual(results.map((r) => r.label), ["ok1", "boom", "ok2"]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /Connection closed/);
  assert.equal(results[2].ok, true, "a failure must not stop later servers");
  assert.deepEqual(agent.seen, ["ok1", "boom", "ok2"]);
  assert.equal(agent.availableTools.length, 2);
});

test("connectServers connects in series, not concurrently", async () => {
  // Regression guard for the contention bug. If someone "optimises" this back
  // to Promise.all, mcp-remote starts failing again on-device.
  let inflight = 0;
  let maxInflight = 0;
  const agent = {
    async addMcpServer() {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight--;
    }
  };
  const servers = Array.from({ length: 4 }, (_, i) => ({
    type: "stdio",
    config: { command: NODE_BIN, args: [`s${i}`], env: {}, cwd: "." }
  }));
  await connectServers(agent, servers);
  assert.equal(maxInflight, 1, "servers must connect one at a time");
});
