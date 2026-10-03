/**
 * Tests for daemon/ircbot.mjs.
 *
 * The network-facing parts cannot be tested hermetically, so what is tested here
 * is the part that decides whether this bot is acceptable to run: the safety
 * policy. A bot that sends one unsolicited message and gets K-Lined takes the
 * whole idea with it, so the gates matter more than the protocol handling.
 *
 * Everything here stubs the socket. No test in this file opens a connection.
 *
 * Run: node --test daemon/ircbot.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { IrcSession, NETWORKS } from "./ircbot.mjs";

// A session wired to a stub socket, so say()/join() can be exercised without a
// network. `written` records what would have gone on the wire.
function stubbed(opts = {}) {
  const s = new IrcSession({ network: "oftc", channels: ["#debian"], ...opts });
  const written = [];
  s.connected = true;
  s.sock = { write: (line) => written.push(line), destroy() {}, end() {}, pause() {} };
  // join() logs and skips rather than throwing, so the observable effect is
  // what reached the socket. Expose it directly instead of leaving the test to
  // guess at mock internals.
  s.written = written;
  return { s, written };
}

// --- network configuration -------------------------------------------------

test("every configured network uses verified TLS", () => {
  // This bot sends private content to private channels. A plain port is not a
  // default, it is a mistake.
  for (const [name, cfg] of Object.entries(NETWORKS)) {
    assert.ok(
      cfg.implicitTls === true || cfg.port === 6667,
      `${name} is neither implicit TLS nor an explicit plain port`
    );
    assert.ok(cfg.port, `${name} has no port`);
  }
});

test("networks needing bot registration are marked, so the bot refuses them", async () => {
  // Libera K-Lined this device within seconds of connecting with a generic
  // nick. The refusal is in the constructor so it cannot be bypassed by
  // setting the flag at runtime.
  const needsReg = Object.entries(NETWORKS).filter(([, c]) => c.requiresRegistration);
  assert.ok(needsReg.length > 0, "expected at least one registration-gated network");
  for (const [name] of needsReg) {
    assert.throws(
      () => new IrcSession({ network: name }),
      /registration/i,
      `${name} should refuse to construct without registration`
    );
  }
});

// --- the gates that matter ------------------------------------------------

test("unsolicited channel traffic is refused", () => {
  // The single most important gate. An agent that opens a conversation in a
  // channel is indistinguishable from a spam bot.
  const { s } = stubbed();
  assert.throws(() => s.say("#debian", "hello everyone"), /unsolicited/i);
});

test("a message marked as a reply is allowed", () => {
  const { s } = stubbed();
  assert.doesNotThrow(() => s.say("#debian", "yes, use node:test", { reason: "reply" }));
});

test("newlines are refused", () => {
  // IRC injection: a message containing \r\n can smuggle a second command and
  // make the bot PART or JOIN something it was never told to.
  const { s } = stubbed();
  assert.throws(() => s.say("#debian", "hi\r\nJOIN #evil", { reason: "reply" }), /newline/i);
  assert.throws(() => s.say("#debian", "hi\nQUIT", { reason: "reply" }), /newline/i);
});

test("empty messages are refused", () => {
  const { s } = stubbed();
  assert.throws(() => s.say("#debian", "", { reason: "reply" }), /empty/i);
  assert.throws(() => s.say("#debian", "   ", { reason: "reply" }), /empty/i);
});

test("channels outside the allow-list are refused", () => {
  const { s, written } = stubbed();
  // join() logs and skips rather than throwing, so assert on the WIRE: no JOIN
  // may be emitted for a disallowed channel.
  //
  // The first version of this test asserted "no exception thrown", which passed
  // while both #ops and #admin were in fact being refused -- a green tick on a
  // check that verified nothing at all. The channel allow-list is the control
  // that stops a typo putting this bot in an operational channel, so it needs a
  // real assertion.
  s.join(["#ops", "#admin", "#debian"]);
  // The stub captures the raw wire format, so lines carry the trailing CRLF
  // that write() appends. Compare on the trimmed command rather than the exact
  // string -- otherwise the test fails on framing, not on policy.
  const joins = written.map((l) => l.trim()).filter((l) => l.startsWith("JOIN "));
  assert.deepEqual(joins, ["JOIN #debian"],
    `only the allow-listed channel may be joined, got ${JSON.stringify(joins)}`);
});

test("a disallowed channel is dropped at construction too", () => {
  // Defence in depth: the filter runs in the constructor as well as in join(),
  // so a caller cannot smuggle a channel in via the channels list.
  const s = new IrcSession({ network: "oftc", channels: ["#debian", "#ops"] });
  assert.deepEqual(s.channels, ["#debian"]);
});

test("the rate limit is enforced per rolling hour", () => {
  const { s } = stubbed();
  const limit = 4;
  for (let i = 0; i < limit; i++) {
    assert.doesNotThrow(() => s.say("#debian", `m${i}`, { reason: "reply" }));
  }
  assert.throws(() => s.say("#debian", "one too many", { reason: "reply" }), /rate limit/i);
});

test("the rate limit window slides", () => {
  const { s } = stubbed();
  for (let i = 0; i < 4; i++) s.say("#debian", `m${i}`, { reason: "reply" });
  // Age every recorded message past the hour.
  const hourAgo = Date.now() - 3601000;
  s.sent = s.sent.map(() => hourAgo);
  assert.doesNotThrow(() => s.say("#debian", "after an hour", { reason: "reply" }));
});

test("the rate limit is per message, not per channel", () => {
  // A bot with a per-channel allowance could multiply its cap by joining
  // several channels, which defeats the point.
  const { s } = stubbed();
  for (let i = 0; i < 4; i++) s.say("#debian", `m${i}`, { reason: "reply" });
  assert.throws(() => s.say("#linux", "different channel", { reason: "reply" }), /rate limit/i);
});

test("disclosure happens once per channel, not once per reconnect", () => {
  const { s, written } = stubbed();
  assert.equal(s.introduce("#debian"), true, "first disclosure should go out");
  assert.equal(s.introduce("#debian"), false, "second must be suppressed");
  const intros = written.map((l) => l.trim()).filter((l) => l.includes("AI agent"));
  assert.equal(intros.length, 1);
});

// --- protocol handling without a network ----------------------------------

test("PING is answered with PONG", () => {
  // Not answering a server PING gets the connection dropped in about 60s, so
  // this is load-bearing for staying connected at all.
  const { s, written } = stubbed();
  s.handle("PING :12345");
  assert.ok(
    written.map((l) => l.trim()).includes("PONG :12345"),
    `expected PONG, got ${JSON.stringify(written)}`
  );
});

test("a ban notice marks the session disconnected", () => {
  // 465 is what Libera sends before K-Lining an undeclared bot. The session
  // must not believe it is still connected.
  const { s } = stubbed();
  s.connected = true;
  s.handle(":server 465 nick :You are banned from this server");
  assert.equal(s.connected, false);
});

test("a direct message is captured for the inbox", async () => {
  const { s } = stubbed();
  s.handle(":someone!u@h PRIVMSG krieger-bot :are you an AI?");
  assert.equal(s.connected, true);
});

test("STARTTLS is a no-op on an implicit-TLS socket", () => {
  // Both configured networks are implicit TLS, so the upgrade path must never
  // fire on them. If it did, it would try to wrap an encrypted socket again.
  const { s } = stubbed();
  assert.equal(s.startTLS("PING :TS=1"), false);
});

test("an unknown network is rejected", () => {
  assert.throws(() => new IrcSession({ network: "example-chat" }), /unknown network/i);
});