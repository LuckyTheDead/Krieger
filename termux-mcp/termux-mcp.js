import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";

const execAsync = promisify(exec);

// Which shell runs a command. The path was hardcoded to Termux's bash, so on
// any other host every shell_exec call failed with a bare
// "spawn /data/data/com.termux/files/usr/bin/bash ENOENT" -- naming a Linux
// path that has nothing to do with the user's actual problem. Worse, tools/list
// advertised the tool as fully working first, so a client had no way to know
// before calling it.
function resolveShell() {
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      `${process.env.USERPROFILE || ""}\\tools\\git\\bin\\bash.exe`,
    ];
    for (const p of candidates) if (p && fs.existsSync(p)) return p;
    return null;
  }
  return "/data/data/com.termux/files/usr/bin/bash";
}

const SHELL = resolveShell();
const SHELL_UNAVAILABLE = SHELL
  ? null
  : "shell_exec needs a POSIX shell. On Windows, install Git for Windows " +
    "(it ships bash.exe); on Termux the shell is always present.";

const server = new McpServer({
  name: "termux-shell",
  version: "1.0.0"
});

server.tool(
  "shell_exec",
  // Say plainly when the tool cannot work on this host. tools/list is the only
  // place a client can learn this before calling, and advertising a tool that
  // is certain to fail wastes a turn and hides the cause behind an ENOENT.
  SHELL
    ? "Execute a command in a POSIX shell (bash). Returns stdout, stderr, and exit code."
    : `UNAVAILABLE on this host -- ${SHELL_UNAVAILABLE} This tool will fail if called.`,
  {
    command: z.string().describe("The shell command to execute"),
    timeout: z.number().int().min(1000).max(600000).optional().describe("Timeout in milliseconds")
  },
  async ({ command, timeout = 120000 }) => {
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;
    delete env.HF_TOKEN;
    delete env.HUGGINGFACE_TOKEN;

    try {
      const result = await execAsync(command, {
        cwd: process.env.HOME || os.homedir(),
        shell: SHELL,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env
      });

      return {
        content: [{
          type: "text",
          text: `Exit code: 0\n\nSTDOUT:\n${result.stdout || "(empty)"}\n\nSTDERR:\n${result.stderr || "(empty)"}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Command failed.\nExit code: ${error.code ?? "unknown"}\n\nSTDOUT:\n${error.stdout || "(empty)"}\n\nSTDERR:\n${error.stderr || error.message || "(empty)"}`
        }]
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
