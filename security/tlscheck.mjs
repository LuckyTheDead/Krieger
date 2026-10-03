#!/data/data/com.termux/files/usr/bin/env node
/**
 * tlscheck -- inspect TLS on a host: version, cipher, cert dates, chain.
 *
 *   node security/tlscheck.mjs openrouter.ai
 *   node security/tlscheck.mjs github.com:443 --json
 *
 * USES `openssl s_client`, which is present on this device. A pure-node TLS
 * implementation would avoid the dependency but could not report the negotiated
 * cipher suite or the full chain, which are most of what makes this useful.
 *
 * Reports what it observes. It does not grade: "expired in 3 days" and
 * "expired in 400 days" are both facts, and only the first is an incident. The
 * summary flags them so you do not have to, but the raw values are printed too
 * because a report you cannot check is just an assertion.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
const OPENSSL = "/data/data/com.termux/files/usr/bin/openssl";

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--")) || "openrouter.ai";
const asJson = argv.includes("--json");
const [host, portRaw] = target.split(":");
const port = portRaw || "443";

const SEV = { good: 0, warn: 1, bad: 2, info: 3 };

async function probe() {
  // `openssl s_client -brief` writes its report to STDERR, not stdout. The first
  // version read stdout, got nothing, and reported "no certificate presented"
  // against a host that plainly presented one. Silent parse failures read as a
  // clean bill of health, which is the worst possible failure for a scanner.
  try {
    const { stderr, stdout } = await execFileAsync(
      OPENSSL,
      ["s_client", "-connect", `${host}:${port}`, "-servername", host, "-brief"],
      { timeout: 25000, maxBuffer: 4 * 1024 * 1024 }
    );
    return { ok: true, stdout: stderr + stdout };
  } catch (err) {
    const combined = (err.stderr || "") + (err.stdout || "");
    if (combined.trim()) return { ok: true, stdout: combined };
    return { ok: false, error: String(err.message).slice(0, 300) };
  }
}

const res = await probe();
if (!res.ok) {
  console.error(`tlscheck: could not connect to ${host}:${port}\n  ${res.error}`);
  process.exit(2);
}

const text = res.stdout;
const findings = [];
const add = (sev, msg, detail) => findings.push({ severity: sev, message: msg, detail });

// --- version and cipher ----------------------------------------------------
// OpenSSL 3.x prints "Protocol version:" and "Ciphersuite:". The first version
// of this script matched /Protocol\s*:/ and got nothing, then reported "no
// certificate presented" on a connection that plainly presented one. Silent
// regex misses are worse than no check: they look like a clean result.
const proto = text.match(/Protocol version\s*:\s*(\S+)/i);
const cipher = text.match(/Ciphersuite\s*:\s*(\S+)/i);
const peer = text.match(/Peer certificate:\s*(.+)/i);
const verify = text.match(/Verification\s*:\s*(\S+)/i);
const group = text.match(/Negotiated\s+\S*\s*group\s*:\s*(\S+)/i);

// --- certificate -----------------------------------------------------------
// openssl s_client prints the leaf in PEM form on request; do that separately
// so the fields are parseable rather than scraped from prose.
let cert = {};
try {
  const { stdout: pemOut } = await execFileAsync(
    OPENSSL,
    ["s_client", "-connect", `${host}:${port}`, "-servername", host, "-showcerts"],
    { timeout: 25000, maxBuffer: 4 * 1024 * 1024 }
  );
  const pem = (pemOut.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/) || [])[0];
  if (pem) {
    // openssl x509 reads PEM from stdin. execFile's `input` option does not
    // exist -- it is execFileSync that takes one -- so the first version threw
    // and the certificate was silently reported as unparseable.
    const { stdout } = await new Promise((resolve, reject) => {
      const p = spawn(OPENSSL, ["x509", "-noout", "-text"]);
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve({ stdout: out }) : reject(new Error(err.slice(0, 200)))));
      p.stdin.write(pem);
      p.stdin.end();
    });
    const subject = (stdout.match(/Subject:\s*(.+)/) || [])[1] || "";
    const issuer = (stdout.match(/Issuer:\s*(.+)/) || [])[1] || "";
    const notBefore = (stdout.match(/Not Before\s*:\s*(.+)/) || [])[1] || "";
    const notAfter = (stdout.match(/Not After\s*:\s*(.+)/) || [])[1] || "";
    const sigAlg = (stdout.match(/Signature Algorithm:\s*(\S+)/) || [])[1] || "";
    // Key type AND size. The first version compared only the bit count and
    // called a 256-bit EC P-256 key "weak" -- 256 bits of ECC is strong, and
    // 256 bits of RSA is not. Comparing sizes across curves is meaningless, so
    // the algorithm decides which threshold applies.
    const keyType = (stdout.match(/Public Key Algorithm:\s*(\S+)/) || [])[1] || "";
    const keyBits = (stdout.match(/Public-Key:\s*\((\d+) bit\)/) || [])[1] || "";
    // SAN: openssl indents continuation lines, and the first regex swallowed the
    // literal "DNS:" prefix into the values. Collect every DNS: entry instead.
    const dnsNames = [...stdout.matchAll(/DNS:([^\s,]+)/g)].map((m) => m[1]).join(", ");

    cert = { subject, issuer, notBefore, notAfter, dnsNames, sigAlg, keyBits, keyType };

    if (dnsNames) {
      const names = dnsNames.split(",").map((s) => s.trim());
      const wildcard = names.some((n) => n.startsWith("*."));
      add(wildcard ? "warn" : "info", wildcard ? "certificate covers a wildcard name" : "certificate names are explicit", names.join(", "));
      if (!names.includes(host) && !wildcard) {
        add("bad", `certificate does not name ${host}`, names.join(", "));
      }
    }
    if (/\bsha1\b/i.test(sigAlg) || /md5/i.test(sigAlg)) {
      add("bad", "certificate is signed with a broken hash", sigAlg);
    } else if (/sha256/i.test(sigAlg)) {
      add("good", "certificate signature hash is modern", sigAlg);
    }
    if (keyBits) {
      const bits = Number(keyBits);
      const isEc = /ec|id-ec/i.test(keyType) || /ecdsa/i.test(sigAlg);
      // ECC: 256 is the strong standard, 224 acceptable, below that weak.
      // RSA: 2048 is the floor, 3072+ better.
      const floor = isEc ? 224 : 2048;
      const label = `${isEc ? "ECC" : "RSA"} ${bits} bit`;
      if (bits < floor) add("bad", "public key is too small", label);
      else if (isEc && bits >= 256) add("good", "public key is strong", label);
      else add("good", "public key size is adequate", label);
    }
    const expires = Date.parse(notAfter);
    if (!Number.isNaN(expires)) {
      const days = Math.round((expires - Date.now()) / 86400000);
      if (days < 0) add("bad", "certificate is EXPIRED", `${notAfter} (${days} days ago)`);
      else if (days < 14) add("warn", "certificate expires very soon", `${notAfter} (${days} days)`);
      else if (days < 30) add("warn", "certificate expires soon", `${notAfter} (${days} days)`);
      else add("good", "certificate is valid", `${notAfter} (${days} days)`);
    }
  }
} catch (e) {
  add("warn", "could not parse the certificate", String(e.message).slice(0, 120));
}

if (proto) {
  const v = proto[1];
  if (/TLSv1\.3/.test(v)) add("good", "negotiated TLS 1.3", v);
  else if (/TLSv1\.2/.test(v)) add("warn", "negotiated TLS 1.2 (1.3 not offered)", v);
  else add("bad", "obsolete TLS version", v);
}
if (verify) {
  add(/^OK/i.test(verify[1]) ? "good" : "bad",
      /^OK/i.test(verify[1]) ? "chain verification succeeded" : "chain verification FAILED",
      verify[1]);
} else if (peer) {
  add("warn", "no verification result reported by openssl", peer[1]);
} else {
  add("warn", "no certificate presented", "");
}
if (group) {
  // A hybrid KEM group means post-quantum key exchange, which is genuinely
  // worth surfacing -- most tooling cannot report it at all.
  add("info", "key exchange group", group[1] + (/MLKEM/i.test(group[1]) ? " (post-quantum hybrid)" : ""));
}

const order = { bad: 0, warn: 1, info: 2, good: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);

if (asJson) {
  console.log(JSON.stringify({ target: `${host}:${port}`, protocol: proto?.[1], cipher: cipher?.[1], cert, findings }, null, 2));
} else {
  console.log(`tlscheck ${host}:${port}`);
  console.log(`  protocol: ${proto?.[1] ?? "?"}`);
  console.log(`  cipher:   ${cipher?.[1] ?? "?"}`);
  if (group) console.log(`  kex:      ${group[1]}`);
  if (peer) console.log(`  peer:     ${peer[1]}`);
  if (cert.notAfter) console.log(`  cert:     ${cert.subject}`);
  if (cert.dnsNames) console.log(`  names:    ${cert.dnsNames}`);
  console.log("");
  for (const f of findings) console.log(`  [${f.severity.toUpperCase()}] ${f.message}${f.detail ? ` -- ${f.detail}` : ""}`);
}
process.exit(findings.some((f) => f.severity === "bad") ? 1 : 0);