// Job definitions.
//
// Three kinds:
//   kind: "llm"    — an unattended call using PROMPT.md as the system prompt,
//                    with memory + prior-run context attached. No tools.
//   kind: "shell"  — runs daemon/scripts/<name>.sh via bash -lc. No model call,
//                    no cost, no credential exposure.
//   kind: "agent"  — a full tiny-agents tool loop over agent.json's MCP servers.
//                    The only kind that can act. Costs many calls per firing;
//                    see daemon/lib/agent.mjs for the permission model.
//
// Shell jobs reference script files rather than inline command strings: inline
// blobs need two levels of quoting and will break the moment the shell text
// contains ${...}.
//
// Every job is inert until enabled: true is set deliberately.

import path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_DIR = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(DAEMON_DIR, "scripts", name);

export const jobs = [
  {
    name: "endpoint-health",
    kind: "shell",
    enabled: false,
    schedule: "*/15 * * * *",
    command: script("endpoint-health.sh"),
    timeoutMs: 40000
  },

  {
    name: "repo-hygiene",
    kind: "shell",
    enabled: false,
    schedule: "17 * * * *",
    command: script("hygiene.sh"),
    timeoutMs: 30000
  },

  {
    name: "watch-disk",
    kind: "shell",
    enabled: false,
    schedule: "0 * * * *",
    command: script("hygiene.sh"),
    timeoutMs: 30000
  },

  {
    name: "overnight-review",
    kind: "llm",
    enabled: false,
    schedule: "0 7 * * *",
    prompt:
      "Overnight review of the unattended run log. Using the context above, report: " +
      "(1) which jobs ran, succeeded, or failed, and how often each did; " +
      "(2) any failure that repeats across runs — a flaky endpoint, a timeout, a bad job definition; " +
      "(3) anything that looks like a silent gap: a job reported success but its output is empty, truncated, or meaningless; " +
      "(4) one concrete change you would make to the job set. " +
      "Be specific and brief. If everything is healthy, say so in two lines and stop.",
    memoryTags: ["daemon", "jobs", "reliability"],
    notify: true,
    notifyMessage: "overnight review ready"
  },

  {
    // Read-only self-review. Deliberately NOT the "edit your own code" job:
    // this one only reads, and reports one change it would make. Promotion to
    // a writing job is a separate decision, made by a human, after watching a
    // few of these. To grant it, set allowWrite (and/or allowShell) on this
    // object -- see daemon/lib/agent.mjs for what each flag exposes.
    //
    // Permissions are the default: no write tools, no shell_exec. So it can
    // read the repo and search memory, and cannot touch anything.
    name: "self-review",
    kind: "agent",
    enabled: true,
    schedule: "13 */2 * * *",
    timeoutMs: 300000,
    memoryTags: ["tiny-agent", "daemon", "architecture"],
    prompt:
      "Review your own codebase (the tiny-agent repo) and report findings.\n\n" +
      "Do this:\n" +
      "1. You have no shell_exec and no write tools. Read code with " +
      "read_text_file, search_files, list_directory.\n" +
      "2. Look for ONE small, safe, non-harmful change that would expand or " +
      "extend functionality: an untested edge case, a missing helper, a " +
      "duplicated block, a comment that no longer matches the code.\n" +
      "3. State it precisely: the file, the line, what changes, and why it is " +
      "non-harmful.\n\n" +
      "Do NOT make any change. You have no write tools, and you should not " +
      "pretend otherwise. Report only.\n\n" +
      "If nothing worth doing, say so in two lines. Do not invent busywork: " +
      "a truthful 'nothing found' is a better result than a weak suggestion."
  }
];
