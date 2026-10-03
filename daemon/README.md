# Krieger daemon

Unattended execution. Lets Krieger make model calls and run commands on a
schedule, with no interactive session open.

## What it does

- **llm jobs** — call `stealth/space-bunny-alpha` (or whatever `agent.json`
  names) with `PROMPT.md` as the system prompt, plus recalled memory and prior
  run history attached. One completion, no tools.
- **shell jobs** — run a script from `daemon/scripts/`. No model call, no cost.
- **agent jobs** — the same tiny-agents tool loop the interactive CLI runs, over
  the MCP servers in `agent.json`. The only kind that can *act*.

Every run is appended to `daemon/runs.jsonl`.

## Quick start

```sh
node daemon/krieger.mjs doctor          # preflight: config, key, prompt sync
node daemon/krieger.mjs list            # jobs and whether they are on
./daemon/start.sh                       # start the resident scheduler
./daemon/start.sh status                # pid + log tail
./daemon/start.sh stop
```

`npm test` from the repo root runs all 58 tests, including the 19 daemon tests.

## Two ways to schedule, because they fail differently

| | resident scheduler | Android job |
|---|---|---|
| start | `./daemon/start.sh` | `./daemon/install-android-job.sh` |
| survives Termux being killed | **no** | **yes** |
| survives reboot | no | yes (`--persisted true`) |
| finest interval | 1 min | 15 min (Android floor) |
| good for | tight intervals, tests | production reliability |

Android's minimum job period is 900000 ms and cannot be changed, so cron
expressions finer than `*/15` are ignored by the OS. Run both if you want
redundancy: the lock file makes that safe.

## Commands

```sh
node daemon/krieger.mjs run <name>       # run one job now, print result
node daemon/krieger.mjs logs [n]         # last n run entries
node daemon/krieger.mjs enable <name>    # user-defined jobs only
node daemon/krieger.mjs disable <name>
node daemon/scheduler.mjs --dry-run      # what is scheduled, call nothing
node daemon/scheduler.mjs --once         # fire anything due, exit (cron entry point)
```

`run <name>` overrides `enabled: false` — typing the command is the consent.

## Defining a job

Builtins are in `daemon/jobs.mjs` (edit to change one). User jobs go in
`daemon/jobs.json`, which **shadows** a builtin of the same name:

```json
{ "jobs": [ { "name": "nightly", "kind": "llm", "enabled": true,
              "schedule": "0 3 * * *", "prompt": "...",
              "memoryTags": ["daemon"], "notify": true } ] }
```

Shell jobs point at a script file rather than an inline command string:

```json
{ "name": "health", "kind": "shell", "enabled": true,
  "schedule": "*/15 * * * *",
  "command": "/data/.../daemon/scripts/endpoint-health.sh", "timeoutMs": 40000 }
```

Inline commands need two levels of quoting and break the moment the text
contains `${...}`. Scripts also get tested on their own.

Every job ships **disabled**. Turn one on deliberately.

## Builtin jobs

| job | schedule | kind | does |
|---|---|---|---|
| `endpoint-health` | `*/15 * * * *` | shell | HTTP status of the configured endpoint; distinguishes 401/402 (key or credit) from down |
| `repo-hygiene` | `17 * * * *` | shell | disk usage, memory/log line counts; notifies over 90% |
| `watch-disk` | `0 * * * *` | shell | same script, hourly |
| `overnight-review` | `0 7 * * *` | llm | reads the run log, reports repeat failures and silent gaps, notifies |
| `self-review` | `13 */2 * * *` | agent | read-only review of the repo; reports one change, makes none |

`repo-hygiene` and `watch-disk` currently point at the same script — they were
meant to be two thresholds. Collapse one before enabling both.

## The `agent` job kind

`kind: "agent"` runs a full tool loop. It is the only kind that can change
something, so it has a permission model the other two do not need.

**Permissions are deny-by-default.** Two independent flags:

| flag | default | effect |
|---|---|---|
| `allowWrite` | `false` | permits `write_file`, `edit_file`, `create_directory`, `move_file`, `memory_store`, `memory_update`, `memory_forget` |
| `allowShell` | `false` | permits `shell_exec` |

They are separate on purpose: running commands and editing files are different
permissions, and granting one must not imply the other.

Enforcement is **before the first model call**, not after. mcp-client executes a
tool call internally and only *then* yields the result, so a check placed after
the yield would merely observe what already happened. Instead the withheld tools
are removed from `agent.availableTools` (what the model is offered) and from the
name→server map (so a hallucinated call finds no server). If the model calls a
withheld tool anyway, the run records `policyChallenges` and nothing executes.

A read-only agent job can read the repo and search memory. It cannot write a
file, write a memory, or run a command.

### Three things that are device-specific and were verified, not assumed

1. **`agent.json` server shape.** It stores `{type, command, args}`; mcp-client
   reads `server.config.command`. Passing the raw shape spawns the literal
   string `"undefined"` and fails ENOENT, which reads as a missing binary rather
   than a shape mismatch. `buildServers()` converts.

2. **`#!/usr/bin/env node` does not work here.** `mcp-server-filesystem` and
   `mcp-remote` are symlinks to env-shebang scripts, and Termux has no
   `/usr/bin/env`. The kernel rejects the shebang before `exec`, so spawning the
   symlink returns ENOENT even though the target exists and is executable.

   **Fixed in `agent.json` on 2026-10-01:** both entries now spawn
   `node <script>` explicitly, which also repaired the *interactive* CLI, not
   just the daemon. `resolveCommand()` is retained as a safety net -- it
   detects a shebang and rewrites if one reappears, and is a no-op otherwise.
   If you edit `agent.json`, keep the `node <script>` form; reintroducing the
   bare symlink breaks the CLI with a bare `ENOENT` that looks like a missing
   binary.

3. **Servers must connect one at a time.** `Agent.loadTools()` uses
   `Promise.all` over every server. With six node MCP servers starting
   simultaneously, `mcp-remote` reliably dies partway through `initialize`
   ("Connection closed") while the other five come up fine; started alone it
   connects in ~4s. `connectServers()` connects in series, which also means one
   dead server no longer takes the whole job down — per-server results land in
   `serversConnected` / `serversFailed`.

An agent job with **zero** connected tools fails loudly rather than running. The
first live run of `self-review` hit exactly this: its tools were never loaded, it
reported that it could see nothing, and returned a confident and entirely
fictional "no findings." That is the failure mode the check exists to prevent.

### Cost

An agent job is many API calls, not one. The `self-review` run described below
made 16 tool calls and took 270s. Budget accordingly before scheduling one every
two hours.

### The built-in `self-review`

Read-only, deliberately. It reviews the repo and reports one change it *would*
make; it has no write tools, so it cannot make it. Promotion to a writing job is
a separate, human decision after watching a few runs.

It found and reported a real bug on 2026-10-01: `serve()` dereferenced
`j.schedule` unguarded in its startup banner, crashing the resident scheduler
whenever an enabled on-demand job (one with no `schedule`) existed. Reproduced,
fixed, and pinned by a test in `scheduler.test.mjs`.

## Safety properties

- **Credentials are stripped from every child process.** `OPENROUTER_API_KEY`,
  `HF_TOKEN`, and friends are deleted from the env before any job runs. A shell
  job cannot read the key that pays for llm jobs.
- **Everything written is passed through `redact()` first.** OpenRouter, HF, and
  GitHub token patterns, plus `Bearer …`. The daemon reads `agent.json`, which
  currently holds a live key, so an unredacted error dump would persist it.
- **A prompt-sync gate.** `loadSystemPrompt` refuses to run a job if `PROMPT.md`
  and `personality/system-prompt.txt` have drifted, so an unattended call cannot
  silently run on a stale persona.
- **A lock file** (`daemon/scheduler.lock`) so two schedulers or two Android
  firings cannot run the same job concurrently. Stale locks are reaped by pid.
- **Atomic writes** for `jobs.json` and `state.json` (temp + rename), so a crash
  mid-write cannot truncate them.
- **The run log is append-only**, matching the memory store's model.

## Cost

Each llm job is one real API call, `max_tokens` 1200. Shell jobs are free.
`overnight-review` is the only builtin that spends anything: one call per day.
An `agent` job costs many calls per firing — see the section above.

## Known limits

- **llm jobs have no tools.** One completion per job, no loop: an llm job cannot
  call `shell_exec` or the memory MCP mid-run, so its prompt must be
  self-contained. Use a shell job, or now an agent job, to *do* something.
- **`recallContext` never writes to memory.** Reads only, so unattended runs
  cannot quietly pollute the store.
- **No retry or backoff.** A failed job is logged as failed. The
  `overnight-review` job is where repeats get noticed.
- **The Android job path is currently unusable.** `install-android-job.sh` needs
  `termux-job-scheduler`, and the Termux:API bridge on this device does not
  answer (diagnosed 2026-09-30: the broadcast is delivered, the reply never
  arrives). Only the resident scheduler can drive jobs until that is fixed.
- **Rotation is still on you.** The credential now lives outside the repo, but
  it has been in session transcripts and in gitignored backup files. Moving it
  stops future leaks, not past ones.

## Credential handling (RESOLVED 2026-10-01)

`agent.json` **no longer contains an API key.** The live OpenRouter key moved to
`~/.secrets.env` (mode 600, outside the repo).

Why it had to move: the filesystem MCP server is rooted at `~/tiny-agent`, so
every file inside the repo is readable by an agent job. A key in `agent.json`
meant an unattended job could read the credential that pays for it.

`resolveApiKey()` already preferred `OPENROUTER_API_KEY` from the environment,
so **no code change was needed** — only the source moved. `agent.cloud.json`,
`agent.cloud.backup.json` and `agent.json.pre-502` no longer carry it either,
and `.backup/` snapshots were scrubbed and gitignored (they held four copies,
one `git add .` from a committed credential).

Loading: `~/.bashrc` sources it with `set -a`, and `daemon/start.sh` sources it
directly — because Termux:Boot runs without a login shell, so `.bashrc` alone is
not enough and the daemon would start fine and then fail every llm job.

Verify: `node daemon/krieger.mjs doctor` should report **`from env`**.

**The key has still been read into session transcripts and should be rotated**,
regardless of where it now lives. Moving it stops future leaks, not past ones.

## Permission model for `agent` jobs

Three independent flags, all deny-by-default. None implies another — granting
`allowWrite` does not grant `allowEgress`, or "write" would silently become
"publish anything":

| flag | default | withholds |
|---|---|---|
| `allowWrite` | `false` | `write_file`, `edit_file`, `create_directory`, `move_file`, `memory_store`, `memory_update`, `memory_forget` |
| `allowShell` | `false` | `shell_exec` |
| `allowEgress` | `false` | `hf_fs`, `hf_fs_write`, `hub_repo_details`, `clipboard-set`, `clipboard-get` |

Egress was added by the security audit of 2026-10-01. The original deny-list
covered only writes and shell, which left a read-then-publish path open.

**This is not a sandbox.** Withheld means "not offered to the model". A job can
still put a secret in its own output text, and that text goes to the provider.
The control that actually closes that is not holding the secret anywhere the
job can read it.

## Remote access

`sshd` runs on port **8022**, bound to **127.0.0.1 by default**. Network
exposure is opt-in:

```sh
./daemon/sshd-up.sh start --lan   # expose to the network
./daemon/sshd-up.sh stop-lan      # withdraw, back to loopback
./daemon/sshd-up.sh status        # reports the current bind address
```

Default-closed since 2026-10-01: a network assessment found it bound to
`0.0.0.0`, reachable by every device on whatever Wi-Fi the phone had joined,
including a workplace network whose authorisation was never established. Auth
was and remains key-only.

See `remote-access-setup.md`.
