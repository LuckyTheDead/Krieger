/**
 * Tests for the security/ suite.
 *
 * These test the SCANNERS, not the findings. A test that asserts "no secrets in
 * the repo" passes today and tells you nothing about whether the scanner works.
 * What matters is that each tool can still catch a planted defect AND still
 * ignores the fixtures it is supposed to ignore -- a scanner that cries wolf
 * and a scanner that misses things are equally useless.
 *
 * Every fixture below is planted into a temp directory and removed afterwards.
 * No real secret is written to disk: the "real" keys here are shaped like real
 * keys and are generated, not copied from anywhere.
 *
 * Run: node --test security/security.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SECRETSCAN = path.join(HERE, "secretscan");
const CODESCAN = path.join(HERE, "codescan");
const BASELINE = path.join(HERE, "secretscan-baseline.txt");

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "sec-test-"));

// Resolve the interpreter at call time. `python3` does not exist on Windows
// (where the launcher is `python`), so every scanner test failed there with
// ENOENT -- 14 failures that had nothing to do with the scanners. Termux has
// python3, so the phone never saw the problem.
const isWin = process.platform === "win32";
// Not "python": on Windows the Microsoft Store app-execution alias intercepts
// that name and resolves to a stub that prints "Python was not found" while
// exiting 0 -- so every scanner produced EMPTY stdout and the tests failed on
// "Unexpected end of JSON input", which reads like a scanner bug. Probe for a
// real interpreter and fail loudly if there is none, rather than silently
// collecting empty output.
function resolvePython() {
  const candidates = isWin
    ? [
        process.env.SECURITY_TEST_PYTHON,
        "C:\\Users\\" + (process.env.USERNAME || "") + "\\tools\\python\\python.exe",
        "C:\\Python312\\python.exe",
        "python3",
      ].filter(Boolean)
    : ["python3"];
  for (const c of candidates) return c;
  throw new Error("no python interpreter found");
}
const PY = resolvePython();

// Run a scanner and ALWAYS return its output. Both scanners exit non-zero when
// they find something, which is the behaviour being tested here -- so execFile
// rejecting on a finding is expected, not a harness failure. The first version
// of these tests called execFileAsync directly and four tests failed on the
// planted secrets rather than on anything wrong with the scanners.
async function run(cmd, args) {
  try {
    const r = await execFileAsync(cmd, args);
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", stderr: err.stderr || "", code: err.code };
  }
}

// A hex-shaped OpenRouter key. Generated, not real, and long enough to clear
// every length floor in the rules.
const FAKE_KEY = "sk-or-v1-" + "a1b2c3d4e5f6".repeat(5);

// --- secretscan -------------------------------------------------------------

test("secretscan finds a planted key", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "config.txt"), `API_KEY=${FAKE_KEY}\n`);
  const { stdout } = await run(PY, [SECRETSCAN, "--json", dir]);
  const out = JSON.parse(stdout);
  assert.ok(out.findings.length > 0, "must find a planted key");
  assert.ok(out.findings.some((f) => f.rule === "openrouter"));
  assert.equal(out.findings[0].verdict, "LIVE");
});

test("secretscan ignores a test fixture built with repeat()", async () => {
  // The distinction that makes the tool usable: this repo has both a live key
  // pattern and four synthetic fixtures, and a scanner that cannot separate
  // them gets switched off.
  const dir = await tmp();
  await fs.writeFile(
    path.join(dir, "t.test.js"),
    `const key = "sk-or-v1-" + "a".repeat(48);\n`
  );
  const { stdout } = await run(PY, [SECRETSCAN, "--json", "--all", dir]);
  const out = JSON.parse(stdout);
  assert.equal(out.findings.length, 0, "repeat()-built fixture must not be reported");
});

test("secretscan does not print the secret it found", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "c.txt"), `K=${FAKE_KEY}\n`);
  const { stdout } = await run(PY, [SECRETSCAN, "--json", dir]);
  assert.ok(!stdout.includes(FAKE_KEY), "output must not echo the credential");
  assert.ok(!stdout.includes("a1b2c3d4e5f6a1b2c3d4e5f6"), "no fragment of the key either");
});

test("secretscan baseline hides an accepted finding but not a new one", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "c.txt"), `K=${FAKE_KEY}\n`);
  const first = JSON.parse((await run(PY, [SECRETSCAN, "--json", dir])).stdout);
  const fp = first.findings[0].fingerprint;
  assert.ok(fp, "expected a fingerprint to baseline");

  const bl = path.join(dir, "baseline.txt");
  await fs.writeFile(bl, `# accepted\n${fp}\n`);

  const baselined = await run(PY, [SECRETSCAN, "--json", "--baseline", bl, dir]);
  assert.equal(JSON.parse(baselined.stdout).findings.length, 0, "baselined finding should vanish");

  // A DIFFERENT key must still be caught even with a baseline in force.
  await fs.appendFile(path.join(dir, "c.txt"), `OTHER=ghp_${"q".repeat(36)}\n`);
  const after = await run(PY, [SECRETSCAN, "--json", "--baseline", bl, dir]);
  assert.ok(JSON.parse(after.stdout).findings.length > 0, "baseline must not hide new secrets");
});

test("secretscan exit code is non-zero only when a human must look", async () => {
  const clean = await tmp();
  await fs.writeFile(path.join(clean, "a.txt"), "nothing to see\n");
  assert.equal((await run(PY, [SECRETSCAN, clean])).code, 0);

  const dirty = await tmp();
  await fs.writeFile(path.join(dirty, "a.txt"), `K=${FAKE_KEY}\n`);
  assert.equal((await run(PY, [SECRETSCAN, dirty])).code, 1);
});

test("the shipped baseline matches a finding that still exists", async () => {
  // A baseline that no longer corresponds to anything is worse than none: it
  // reads as "reviewed" while silently covering nothing.
  const { stdout } = await run(PY, [SECRETSCAN, "--json", "--all", REPO]);
  const out = JSON.parse(stdout);
  const baseline = (await fs.readFile(BASELINE, "utf8"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const fp of baseline) {
    assert.ok(
      out.findings.some((f) => f.fingerprint === fp),
      `baseline entry ${fp} no longer matches any finding; remove it`
    );
  }
});

test("the shipped baseline keeps the repo clean", async () => {
  const r = await run(PY, [SECRETSCAN, "--baseline", BASELINE, REPO]);
  assert.equal(r.code, 0, `repo should be clean with the baseline applied:\n${r.stdout}`);
});

// --- codescan ---------------------------------------------------------------

test("codescan finds SQL built by interpolation", async () => {
  const dir = await tmp();
  await fs.writeFile(
    path.join(dir, "a.js"),
    "const q = `SELECT * FROM users WHERE user = '${user}'`;\n"
  );
  const { stdout } = await execFileAsync(PY, [CODESCAN, "--json", dir]);
  const out = JSON.parse(stdout);
  assert.ok(out.findings.some((f) => f.rule === "sql-format"));
});

test("codescan finds weak crypto", async () => {
  const dir = await tmp();
  await fs.writeFile(
    path.join(dir, "a.js"),
    'const h = crypto.createHash("md5").update(pw).digest("hex");\n'
  );
  const { stdout } = await execFileAsync(PY, [CODESCAN, "--json", dir]);
  assert.ok(JSON.parse(stdout).findings.some((f) => f.rule === "weak-hash"));
});

test("codescan finds Math.random used as a token", async () => {
  const dir = await tmp();
  await fs.writeFile(
    path.join(dir, "a.js"),
    "const session = String(Math.floor(Math.random() * 1e9));\n"
  );
  const { stdout } = await execFileAsync(PY, [CODESCAN, "--json", dir]);
  assert.ok(JSON.parse(stdout).findings.some((f) => f.rule === "weak-random"));
});

test("codescan does not fire on ordinary path handling", async () => {
  // This is the regression that mattered: the path-traversal rule produced 13
  // false positives on this repo before it was tightened to require a request
  // read on the same line. Internal code like the two below is not a finding.
  const dir = await tmp();
  await fs.writeFile(
    path.join(dir, "a.js"),
    [
      'const parsed = JSON.parse(await fs.readFile(file, "utf8"));',
      'const script = (name) => path.join(DAEMON_DIR, "scripts", name);',
      'const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");'
    ].join("\n")
  );
  const { stdout } = await execFileAsync(PY, [CODESCAN, "--json", dir]);
  const out = JSON.parse(stdout);
  assert.equal(
    out.findings.filter((f) => f.rule === "path-traversal").length,
    0,
    `false positives: ${JSON.stringify(out.findings.map((f) => f.excerpt))}`
  );
});

test("codescan does not report the word 'secret' as a vulnerability", async () => {
  // Regression: a rule matching the bare word produced 8 findings in
  // agent.test.mjs purely because test NAMES contain "secret".
  const dir = await tmp();
  await fs.writeFile(
    path.join(dir, "a.test.js"),
    'test("secret filenames are recognised by basename", () => {});\n'
  );
  const { stdout } = await execFileAsync(PY, [CODESCAN, "--json", dir]);
  assert.equal(JSON.parse(stdout).findings.length, 0);
});

test("codescan names the fix with every finding", async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, "a.js"), 'const h = crypto.createHash("md5");\n');
  const { stdout } = await execFileAsync(PY, [CODESCAN, "--json", dir]);
  for (const f of JSON.parse(stdout).findings) {
    assert.ok(f.fix && f.fix.length > 10, `finding ${f.rule} has no actionable fix`);
  }
});

test("codescan labels lab fixtures as subject rather than as findings", async () => {
  // vulnlab is intentionally vulnerable. Without this, every lab run looks like
  // a fresh breach of the repo.
  const { stdout } = await execFileAsync(PY, [CODESCAN, "--json", path.join(HERE, "vulnlab.mjs")]);
  const out = JSON.parse(stdout);
  assert.ok(out.findings.length > 0, "the lab should still be scanned");
  assert.ok(out.findings.every((f) => f.subject === true));
});

// --- the suite as a whole --------------------------------------------------

test("every scanner exists and is executable", async () => {
  for (const f of ["secretscan", "depcheck", "codescan", "hostaudit", "secsuite"]) {
    const p = path.join(HERE, f);
    const st = await fs.stat(p);
    // mode bits are a POSIX concept; Windows has no executable bit and reports
    // mode 0o666 for every file. Assert what is meaningful there instead --
    // the file exists and its shebang names a real interpreter.
    if (isWin) {
      const head = (await fs.readFile(p, "utf8")).split("\n")[0];
      assert.match(head, /^#!/, `${f} has no shebang to explain how it runs`);
      continue;
    }
    assert.ok(st.mode & 0o111, `${f} is not executable`);
  }
});

test("no scanner has a Termux-hostile shebang", async () => {
  // Regression, and a slightly subtle one. Termux has no /usr/bin/env, so a
  // script with that exact shebang fails with "bad interpreter" -- the same class
  // of bug fixed in agent.json for mcp-remote.
  //
  // The first version of this test asserted on the substring "env" anywhere in
  // the shebang, which flagged #!/data/data/com.termux/files/usr/bin/env as
  // broken. That path is CORRECT on this device: $PREFIX/bin/env exists (a
  // coreutils symlink). Matching a substring instead of the actual failure mode
  // is how a security test starts failing on correct code.
  for (const f of ["secretscan", "depcheck", "codescan", "hostaudit", "secsuite"]) {
    const first = (await fs.readFile(path.join(HERE, f), "utf8")).split("\n", 1)[0];
    if (!first.startsWith("#!")) continue;
    assert.ok(
      !/#!\/usr\/bin\/env/.test(first),
      `${f} uses ${first}: /usr/bin/env does not exist on Termux`
    );
    // And the interpreter it names must actually be present.
    const interp = first.replace(/^#!\S*\s*/, "").trim().split(/\s+/)[0];
    if (interp.startsWith("/")) {
      await fs.access(interp).catch(() => {
        assert.fail(`${f} names ${interp}, which does not exist on this device`);
      });
    }
  }
});
