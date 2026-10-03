# Security suite

Static and local checks for this repository and this device. Everything here
runs offline except `tlscheck`, and nothing here scans the network — that
boundary is deliberate and explained below.

```sh
npm run sec              # everything
npm run sec:quick        # skip the network-dependent checks
./security/secsuite      # same as npm run sec
```

Individual tools:

| tool | what it does |
|---|---|
| `security/secretscan` | finds credentials, classifies them, never prints the value |
| `security/codescan` | finds known-weak source patterns, names the fix |
| `security/hostaudit` | this device's services, credential location, file modes, git hygiene |
| `security/depcheck` | dependency reachability and version pinning |
| `security/tlscheck.mjs` | TLS version, cipher, cert dates, chain, key-exchange group |
| `security/vulnlab.mjs` | a deliberately vulnerable local service, for proving the scanners work |
| `security/secsuite` | runs all of the above, one summary |

## The two rules everything else follows from

**1. Never print a secret.** `secretscan` emits a redacted preview
(`sk-or-...66f4`) and a fingerprint — `sha256(rule + value)`, truncated — so a
finding can be recorded without the report becoming a credential store. There
is a test asserting the key does not appear in output.

**2. A check that silently skips is worse than no check.** `secsuite` prints
what it skipped and says *"a skipped check is NOT a pass"*. Several tools here
reported success while parsing nothing at all before they were fixed, and a
silently-empty scanner is indistinguishable from a clean one.

## secretscan: LIVE vs REVIEW vs SYNTHETIC

The problem a plain `grep` cannot solve: this repo contains **both** a live
OpenRouter key (in `agent.json`, before the 2026-10-01 audit) **and** four
synthetic fixtures in `daemon.test.mjs` built as `"sk-or-v1-" + "a".repeat(48)`.
A scanner that cannot separate them gets switched off.

Every match is classified:

| verdict | meaning |
|---|---|
| `LIVE` | real credential-shaped value, not constructed in code |
| `REVIEW` | cannot decide — needs a human |
| `SYNTHETIC` | built by `repeat`/concatenation, or spelled-out sample data |
| `PLACEHOLDER` | contains filler: `your-key`, `<token>`, `xxxx` |
| `EXAMPLE` | matches a published documentation sample |

Entropy is measured **per finding, not per file**, and with **bands per
charset**. This matters: Shannon entropy is bounded by `log2(charset)`, so a hex
key tops out near 4.0 bits/char while a base62 key reaches ~5.9. The first
version used one threshold of 4.2 and demoted the *actual* OpenRouter key
(scoring 4.14) to `REVIEW` — a live credential nearly missed by a number I
guessed.

Exit codes: `0` clean, `1` something needs a human. Usable as a pre-commit gate.

### Baseline

`security/secretscan-baseline.txt` records findings you have reviewed and
accepted, so the gate stays green unless something *new* appears. Without it,
one accepted fixture keeps the exit status permanently red.

A test asserts every baseline entry still corresponds to a real finding — a
baseline covering nothing reads as "reviewed" while hiding nothing.

## codescan: named fixes

Every rule names its remediation, so the fix is visible at the finding rather
than being left as homework. Injection, XSS, path traversal, weak crypto,
predictable randomness, disabled TLS verification, CORS, `shell=True`, pickle,
unsafe YAML, JWT `alg: none`, and more.

Three rules needed rewriting after false positives, and the comments record why:

- `sql-concat` matched the word `SELECT` inside a **string literal**, firing on
  prose. Now requires the concatenation to be in an assignment, `return`, or a
  query call.
- `crypto-random-tokens` matched the bare word `token|secret|nonce`, producing
  **eight** findings in `agent.test.mjs` purely because test *names* contain the
  word "secret". Reporting that as a vulnerability is how a scanner becomes
  background noise.
- `path-traversal` keyed on a caller-ish variable name and produced **13 false
  positives** on this repo, because `fs.readFile(file)` is ordinary internal
  code. Now it requires a request read on the same line — the actual signal. The
  limit of that approach is stated in the finding text rather than hidden.

Result on this repo after tuning: **1 finding**, in a test fixture generating
IDs with `Math.random`. Real pattern, correctly low-stakes.

## vulnlab: proving the scanners still work

A security tool's output is a claim, and a claim you have never seen fail is one
you cannot evaluate. `security/vulnlab.mjs` is a small HTTP server on
`127.0.0.1:8099` with six textbook flaws, each labelled with what a scanner
*should* report:

| route | flaw |
|---|---|
| `/sqli` | query built by concatenation — injection succeeds |
| `/xss` | reflected, unescaped |
| `/read` | path from caller-supplied name |
| `/weakhash` | unsalted MD5 |
| `/config` | hardcoded credential |
| `/token` | session token from `Math.random` |

```sh
node security/vulnlab.mjs &
curl "http://127.0.0.1:8099/sqli?user=admin'+OR+'1'='1"
curl "http://127.0.0.1:8099/xss?q=<script>alert(1)</script>"
```

All six were confirmed exploitable end to end before the scanners were judged
against them. `codescan` labels this file as *subject* rather than as findings,
so running the suite does not read as a fresh breach.

**Loopback only. Do not expose it. The flaws are real, not simulated.**

## Scope, stated plainly

- **This suite does not scan the network.** `hostaudit` probes one port on
  *this device's own address* to confirm a listener is genuinely reachable
  rather than merely running — that is a self-check, not a sweep. Finding
  neighbours' open ports is not this repository's business.
- **`depcheck` reports reachability and pinning, not vulnerabilities.** It has no
  advisory database and says so in its own output. A dependency being
  *reachable* is a priority signal; it is not a CVE.
- **`tlscheck` reports what it observes.** It does not grade a site, and it
  prints raw values alongside its flags so the report can be checked.

## A real finding this suite produced

`hostaudit` found **15 files under `.backup/` already tracked in git**. The
`.gitignore` rule was committed and working, but `.gitignore` does not apply to
files git already tracks — those had been committed in the initial commit,
before any hardening. They contained **no** credential (scrubbed earlier), but
they were stale snapshots of old code living in history.

```sh
git rm -r --cached .backup     # files stay on disk, leave the index
```

The check now reports tracked-but-ignored files as their own finding, because
that gap is invisible to `git check-ignore` — which returns "not ignored" for
the *directory* even when the rule is working correctly, since `.backup/` only
matches paths beneath it. The first version of the check got this wrong in both
directions and was corrected against the actual behaviour.

## Limits

- No root, no Magisk. No SYN scans or raw sockets — `nmap` is connect-only here.
- `/proc/net` and `ip` netlink are blocked, so no MAC fingerprinting and no
  neighbour enumeration.
- The Termux:API bridge is dead, so `termux-api-mcp`'s own tests remain flaky.
- RAM is the binding constraint: ~700 MB free of 3.5 GB, shared with Android.
  Large scan campaigns will thrash.
- Regex scanners have false negatives by construction. `codescan` misses data
  flow split across lines, and no regex here does taint analysis. It is a
  checklist, not a proof of absence.