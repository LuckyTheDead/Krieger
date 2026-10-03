#!/data/data/com.termux/files/usr/bin/env node
/**
 * vulnlab -- a deliberately vulnerable local service, for testing the scanner.
 *
 *   node security/vulnlab.mjs [port]        # default 8099, binds 127.0.0.1
 *
 * THIS IS INTENTIONALLY VULNERABLE. Every route below is a textbook flaw, kept
 * in one file so the whole catalogue is readable in one screen. It binds to
 * loopback only. Do not expose it, do not point it at anything real, and do not
 * copy it into anything that ships.
 *
 * The point: a security tool's output is a claim, and a claim you have never
 * seen fail is a claim you cannot evaluate. These routes exist so the scanner
 * has known-positive and known-negative cases. Each is labelled with what a
 * scanner SHOULD report, so a miss is as visible as a false positive.
 *
 * Deliberately absent: anything that touches the network beyond loopback, any
 * credential, any real user data, and any dependency with a known CVE. The
 * vulnerabilities are all in THIS file's own logic, which is the honest way to
 * build a test fixture -- the flaws are auditable rather than inherited.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.argv[2] || 8099);
const HOST = "127.0.0.1"; // loopback. Deliberately not 0.0.0.0.

// --- fixtures --------------------------------------------------------------
// Obviously fake, obviously labelled. A scanner should still flag the shapes;
// that is the point of the check.
const DB = [
  { id: 1, user: "admin", password: "admin123", note: "lab account" },
  { id: 2, user: "guest", password: "guest", note: "lab account" }
];

const log = (...a) => console.log("[vulnlab]", ...a);

// `async` because /read awaits a file read. The first draft had a bare
// callback and an `await` inside it, which is a syntax error -- caught by
// starting the server rather than by reading it carefully.
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, body, type = "text/plain") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };

  log(req.method, url.pathname);

  // -------------------------------------------------------------------------
  // 1. SQL injection -- string-concatenated query.
  //    SHOULD REPORT: hardcoded SQL built by concatenation; credentials in source.
  if (url.pathname === "/sqli") {
    const user = url.searchParams.get("user") || "";
    // The flaw: interpolating input directly. In a real app this would be a
    // database call; here the "query" is string concatenation, which is the
    // same defect and is detectable without a database.
    const query = `SELECT * FROM users WHERE user = '${user}'`;
    if (/'\s*or\s*'?1'?\s*=\s*'?1/i.test(user)) {
      return send(200, `QUERY: ${query}\n\nLOGGED IN as admin (injection succeeded)`);
    }
    return send(200, `QUERY: ${query}\n\nno rows`);
  }

  // -------------------------------------------------------------------------
  // 2. Reflected XSS -- unescaped user input in HTML.
  //    SHOULD REPORT: unescaped interpolation into an HTML response.
  if (url.pathname === "/xss") {
    const q = url.searchParams.get("q") || "";
    return send(200, `<!doctype html><h1>${q}</h1>`, "text/html");
  }

  // -------------------------------------------------------------------------
  // 3. Path traversal -- reads a file named by the caller.
  //    SHOULD REPORT: user-controlled path joined without normalisation.
  if (url.pathname === "/read") {
    const p = url.searchParams.get("p") || "";
    // Bounded to this directory and to text files. A traversal here can read
    // other lab files, nothing more -- the guard below is a containment
    // measure, not a fix for the class of bug being demonstrated.
    const base = import.meta.dirname;
    const target = path.join(base, "..", p);
    if (!target.startsWith(base)) return send(403, "out of base (lab guard)");
    try {
      return send(200, await fs.readFile(target, "utf8"));
    } catch {
      return send(404, "not found");
    }
  }

  // -------------------------------------------------------------------------
  // 4. Weak hash -- unsalted MD5 for password storage.
  //    SHOULD REPORT: MD5/SHA1 used for passwords.
  if (url.pathname === "/weakhash") {
    const pw = url.searchParams.get("pw") || "";
    const md5 = crypto.createHash("md5").update(pw).digest("hex");
    return send(200, `md5(${pw}) = ${md5}\n(md5 is not a password hash; use scrypt/argon2)`);
  }

  // -------------------------------------------------------------------------
  // 5. Hardcoded credential in source.
  //    SHOULD REPORT: high-entropy credential literal in a scanned file.
  if (url.pathname === "/config") {
    return send(200, `api_token = ${"sk-or-v1-" + "a".repeat(48)}\n(fixture; do not use)`);
  }

  // -------------------------------------------------------------------------
  // 6. Weak session token -- predictable, not from a CSPRNG.
  //    SHOULD REPORT: Math.random or a counter used for a security token.
  if (url.pathname === "/token") {
    const t = String(Math.floor(Math.random() * 1e9));
    return send(200, `session=${t}\n(predictable: Math.random is not a CSPRNG)`);
  }

  // -------------------------------------------------------------------------
  // 7. Missing security headers, and a permissive CORS.
  //    SHOULD REPORT: no CSP, no HSTS, wildcard CORS.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Server", "vulnlab/1.0");
  return send(404, "not found");
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (intentionally vulnerable)`);
  log("routes: /sqli /xss /read /weakhash /config /token");
});

export { server, DB };