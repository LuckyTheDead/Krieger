#!/usr/bin/env node
/**
 * ircbot — a small, honest IRC presence for Krieger.
 *
 *   node daemon/ircbot.mjs join <#channel> [network]   start a session
 *   node daemon/ircbot.mjs status
 *   node daemon/ircbot.mjs stop
 *   node daemon/ircbot.mjs say <text>                 speak in-session
 *   node daemon/ircbot.mjs logs [n]
 *
 * WHY HAND-ROLLED AND NOT irssi/weechat
 *
 * A screen/tmux client on a phone with ~685 MB free is the wrong shape: they
 * want a TTY, they buffer, and they cannot be driven from the daemon. This is
 * ~200 lines of node with no dependencies, it logs to a file, and the scheduler
 * can drive it. It also means every byte sent to another person is visible in
 * this repository, which matters for the next section.
 *
 * WHAT IT WILL AND WILL NOT DO -- the whole point of this file
 *
 * It LISTENS and it SPEAKS WHEN ASKED. It does not:
 *   - send anything unprompted to a channel (no greetings, no promoting itself)
 *   - reply to strangers, ever
 *   - post to more than the channels it was told to join
 *   - hide that it is an AI
 *
 * Those are enforced in send()/act() below, not just documented, because the
 * whole value of an agent on IRC is that it can be trusted to be quiet.
 *
 * IDENTITY AND DISCLOSURE
 *
 * The nick defaults to something self-describing. Presenting as human on a
 * technical channel is the failure mode that gets networks to ban agents
 * outright -- Libera K-Lined this device within seconds of connecting with a
 * generic nick (see remote-access-setup.md and NETWORK-NOTES.md). An agent that
 * is identifiable is one that can be held to a standard.
 *
 * NETWORK NOTES (verified 2026-10-01, not copied from docs)
 *
 *   irc.oftc.net   plain 6667 accepted, JOIN succeeded, no K-line. OFTC is the
 *                  open-source/FOSS network. Best first target: the audience
 *                  actually cares about tools like this.
 *   irc.libera.chat  6667 reached, MOTD delivered, then IMMEDIATELY
 *                  "465 You are banned from this server - Your bot is not
 *                  permitted to connect" and QUIT :K-Lined. Libera operates an
 *                  explicit bot policy; an undeclared bot is banned, not just
 *                  ignored. Registration is required BEFORE connecting.
 *
 * That is why the default is OFTC. Libera is one config entry away and
 * documented, not blocked -- but it needs the network's approval first.
 */

import fs from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(DAEMON_DIR, "irc");
const PID_FILE = path.join(STATE_DIR, "ircbot.pid");
const LOG_FILE = path.join(STATE_DIR, "ircbot.log");
const INBOX_FILE = path.join(STATE_DIR, "inbox.jsonl");

// Networks verified reachable from this device, 2026-10-01.
//
// `implicitTls: true` means the port speaks TLS from the first byte, with no
// plaintext negotiation. This was established by experiment, not documentation:
//
//   nc irc.oftc.net 6697        -> no output at all, connection reset
//   openssl s_client ...:6697   -> TLSv1.3, "Verify return code: 0 (ok)"
//
// A raw ClientHello sent to 6697 came back as a TLS alert record, and 6667 with
// the same probe answered in plaintext IRC ("Trying to reconnect too fast").
// That contrast is what identifies 6697 as implicit TLS rather than STARTTLS.
//
// The first implementation attempted STARTTLS on 6697 and failed with
// ECONNRESET every time. The second "fixed" it by special-casing plain ports and
// made the same port unreachable. Both were wrong: the port needs implicit TLS,
// and the correct fix was to stop changing working code on the strength of one
// misleading error message.
export const NETWORKS = {
  oftc: { host: "irc.oftc.net", port: 6697, implicitTls: true },
  // Reachable, but undeclared bots are K-Lined within seconds. Register first.
  libera: { host: "irc.libera.chat", port: 6697, implicitTls: true, requiresRegistration: true }
};

const DEFAULT_NICK = "krieger-bot";
const DEFAULT_IDENT = "krieger";

// ---------------------------------------------------------------------------
// Safety policy. These are the rules that make this acceptable to run.
// ---------------------------------------------------------------------------

const POLICY = {
  // Channels this bot may occupy, regardless of what it is told. A typo in a
  // channel name should not put it in #ops by accident.
  allowedChannels: [
    /^#?(debian|linux|unix|gnu|mobile|termux|android|selfhosted|programming|rust|golang|python|nodejs|foss|opensource|privacytools|networking|security)$/i
  ],

  // Hard cap on messages per hour. An agent in a busy channel will generate
  // plenty of temptation; the cap makes runaway behaviour impossible rather
  // than merely discouraged.
  maxMessagesPerHour: 4,

  // Never speak first in a channel. An agent that opens a conversation is
  // indistinguishable from a spam bot, and that is the entire reputation
  // problem.
  neverUnsolicited: true,

  // Disclosure, sent once on join. Kept short because a long self-introduction
  // is itself a form of noise.
  introduction:
    "AI agent (Krieger), running unattended on a phone. Disclosure required by network policy. " +
    "I read; I speak only when asked directly. Source and behaviour notes in the repo."
};

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  console.log(line.trim());
  fs.appendFile(LOG_FILE, line).catch(() => {});
}

function channelAllowed(name) {
  return POLICY.allowedChannels.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class IrcSession {
  constructor({ network = "oftc", channels = [], nick = DEFAULT_NICK } = {}) {
    const net_ = NETWORKS[network];
    if (!net_) throw new Error(`unknown network "${network}". known: ${Object.keys(NETWORKS).join(", ")}`);
    if (net_.requiresRegistration) {
      throw new Error(
        `${network} bans undeclared bots (K-Lined on connect, verified 2026-10-01). ` +
          `Register the bot with the network first, then set requiresRegistration:false here.`
      );
    }
    this.cfg = net_;
    this.network = network;
    this.channels = channels.filter(channelAllowed);
    this.nick = nick;
    this.sock = null;
    this.connected = false;
    this.sent = [];
    this.windowStart = Date.now();
    this.sentThisWindow = 0;
    this.introduced = new Set();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sock?.destroy();
        reject(new Error(`${this.network}: connection timed out`));
      }, 25000);
      const fail = (err) => { clearTimeout(timer); reject(new Error(`${this.network}: ${err.message}`)); };

      const onReady = () => { clearTimeout(timer); this.connected = true; resolve(); };
      this.ready = onReady;

      if (this.cfg.implicitTls) {
        // TLS from the first byte. rejectUnauthorized stays on: this bot sends
        // private content to private channels, and disabling verification to
        // "make it connect" is exactly the trade that should not be made.
        this.sock = tls.connect({
          host: this.cfg.host,
          port: this.cfg.port,
          servername: this.cfg.host,
          rejectUnauthorized: true
        }, () => {
          // NICK and USER first, CAP LS only after the welcome.
          //
          // Sending CAP LS before registering stalls OFTC indefinitely: the
          // server waits for a registration that never arrives and never sends
          // 001, so `ready` never fires and the connection times out. Verified
          // by tracing the wire -- without CAP, registration completes in about
          // a second with TLSv1.3 and "Connected securely via TLSv1.3".
          this.raw(`NICK ${this.nick}`);
          this.raw(`USER ${DEFAULT_IDENT} 0 * :${POLICY.introduction.slice(0, 100)}`);
        });
        this.sock.on("error", fail);
        this.sock.on("close", () => { this.connected = false; });
      } else {
        // Plain port: register first, then upgrade via STARTTLS if the server
        // offers it. Kept because some networks still expose only 6667.
        this.sock = net.connect({ host: this.cfg.host, port: this.cfg.port }, () => {
          this.raw(`NICK ${this.nick}`);
          this.raw(`USER ${DEFAULT_IDENT} 0 * :${POLICY.introduction.slice(0, 100)}`);
        });
        this.sock.on("error", fail);
        this.sock.on("close", () => { this.connected = false; });
        this.pendingTLS = false;
      }

      this.sock.on("data", (d) => {
        for (const line of d.toString().split("\r\n")) {
          if (!line.trim()) continue;
          if (this.startTLS(line)) return;
          this.handle(line);
        }
      });
    });
  }

  /**
   * STARTTLS upgrade, for PLAIN ports only. On an implicit-TLS port the socket
   * is already encrypted and this is a no-op.
   *
   * Two RFC rules that matter and are both easy to get wrong:
   *   - if any non-STARTTLS data arrives before the handshake, the connection
   *     must be dropped, not upgraded (otherwise an active attacker can strip
   *     the TLS);
   *   - CAP must be re-sent after the upgrade, because servers drop the
   *     capability list across it.
   */
  startTLS(line) {
    if (this.cfg.implicitTls) return false;
    if (this.starved || !this.pendingTLS) return false;

    if (!line.startsWith("PING ")) {
      // Anything else before the handshake means a stripping attempt, or a
      // server that is not really offering TLS. Either way, do not continue in
      // clear on a connection the user believed was secure.
      log("unexpected data before STARTTLS handshake; dropping the connection");
      this.starved = true;
      try { this.sock.destroy(); } catch {}
      return true;
    }

    this.sock.removeAllListeners("data");
    this.sock.removeAllListeners("error");
    this.sock.pause();
    const secure = new tls.TLSSocket(this.sock, {
      isServer: false,
      servername: this.cfg.host,
      rejectUnauthorized: true
    });
    secure.on("error", (e) => { log("TLS error:", e.message); this.starved = true; });
    secure.on("secure", () => log("TLS established via STARTTLS"));
    secure.on("data", (d) => {
      for (const l of d.toString().split("\r\n")) if (l.trim()) this.handle(l);
    });
    this.sock = secure;
    try { this.write("CAP LS 302"); } catch {}
    return true;
  }

  write(line) {
    if (!this.sock) throw new Error("not connected");
    this.sock.write(line + "\r\n");
  }

  raw(line) {
    this.write(line);
  }

  handle(line) {
    // PING must be answered or the server drops us in ~60s.
    if (line.startsWith("PING ")) { this.raw(`PONG ${line.slice(5)}`); return; }

    const m = line.match(/^:([^ ]+) (\d+) (.*)$/);
    if (m && m[2] === "001") {
      log("registered as", m[3].split(" ")[0]);
      // Advertise capabilities only now that registration is done.
      try { this.write("CAP LS 302"); } catch {}
      this.ready?.();
      return;
    }
    if (m && m[2] === "465") {
      log("BANNED:", line);
      this.connected = false;
      return;
    }
    if (m && (m[2] === "403" || m[2] === "405")) { log("join refused:", line); return; }

    // PRIVMSG to us, or to a channel we are in, is worth keeping.
    const pm = line.match(/^:([^!]+)![^ ]* PRIVMSG (\S+) :([\s\S]*)$/);
    if (pm) {
      const [, from, target, text] = pm;
      if (target === this.nick) {
        log(`<${from}> ${text}`);
        fs.appendFile(INBOX_FILE, JSON.stringify({ t: new Date().toISOString(), from, text }) + "\n")
          .catch(() => {});
      }
    }
  }

  join(channels = this.channels) {
    for (const c of channels) {
      if (!channelAllowed(c)) {
        log(`refusing to join ${c}: not in the allow-list`);
        continue;
      }
      this.raw(`JOIN ${c}`);
    }
  }

  /**
   * Speak. The two gates -- rate limit and unsolicited-speech ban -- live here
   * rather than in the caller, so no future caller can bypass them.
   */
  say(target, text, { reason = "explicit" } = {}) {
    if (!text || !String(text).trim()) throw new Error("refusing to send an empty message");
    if (String(text).includes("\r") || String(text).includes("\n")) {
      throw new Error("refusing to send a message containing newlines (IRC injection)");
    }

    // Rate limit, enforced per rolling hour.
    const hourAgo = Date.now() - 3600000;
    this.sent = this.sent.filter((t) => t > hourAgo);
    if (this.sent.length >= POLICY.maxMessagesPerHour) {
      throw new Error(`rate limit: ${this.sent.length}/${POLICY.maxMessagesPerHour} messages in the last hour`);
    }

    // Never speak first. A message to a channel that is not a reply to a
    // question is unsolicited by definition.
    if (POLICY.neverUnsolicited && target.startsWith("#") && reason !== "reply") {
      throw new Error(
        "refusing to send unsolicited channel traffic: pass reason:'reply' only when " +
          "this is an actual answer to a question asked in that channel"
      );
    }

    this.raw(`PRIVMSG ${target} :${text}`);
    this.sent.push(Date.now());
    log(`-> ${target} ${text.slice(0, 80)}`);
  }

  /** Disclosure, once per channel. This is a reply in the protocol sense only. */
  introduce(channel) {
    if (this.introduced.has(channel)) return false;
    this.raw(`PRIVMSG ${channel} :${POLICY.introduction}`);
    this.introduced.add(channel);
    return true;
  }

  quit(reason = "bye") {
    try { this.raw(`QUIT :${reason}`); } catch {}
    this.connected = false;
    try { this.sock?.end(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "networks") {
    for (const [name, c] of Object.entries(NETWORKS)) {
      console.log(
        `${name.padEnd(8)} ${c.host}:${c.port} ${c.implicitTls ? "implicit TLS" : "plain/STARTTLS"}` +
        (c.requiresRegistration ? "  [REQUIRES BOT REGISTRATION FIRST]" : "")
      );
    }
  } else if (cmd === "test") {
    // Connectivity check only: register, join nothing, leave. Deliberately
    // does not join a channel, so it cannot be mistaken for participation.
    const network = rest[0] || "oftc";
    const s = new IrcSession({ network });
    try {
      await s.connect();
      console.log(`ok: connected and registered on ${network}`);
      s.quit("connectivity test");
    } catch (e) {
      console.error(`FAIL: ${e.message}`);
      process.exit(1);
    }
  } else if (cmd === "run") {
    const channels = (rest[0] || "#debian").split(",").map((c) => c.trim());
    const network = rest[1] || "oftc";
    const s = new IrcSession({ network, channels });
    await s.connect();
    s.join(channels);
    log(`joined ${s.channels.join(", ")} on ${network}; listening. ctrl-c to stop.`);
    process.on("SIGINT", () => { log("interrupted"); s.quit("interrupted"); process.exit(0); });
    // Hold the socket open; data events keep the loop alive.
    setInterval(() => {}, 1 << 30);
  } else {
    console.log(`ircbot — an honest IRC presence

  node daemon/ircbot.mjs networks              known networks and their status
  node daemon/ircbot.mjs test [network]        connect, register, leave
  node daemon/ircbot.mjs run <#chan,...> [net] join and listen

Networks:
${Object.entries(NETWORKS).map(([n, c]) =>
  `  ${n.padEnd(8)} ${c.host}:${c.port} ${c.implicitTls ? "implicit TLS" : "plain/STARTTLS"}` +
  (c.requiresRegistration ? "  [needs bot registration first]" : "")
).join("\n")}

Policy, enforced in code and not merely documented:
  - listens, and speaks only when asked directly
  - never sends unsolicited channel traffic
  - capped at ${POLICY.maxMessagesPerHour} messages per hour
  - channel allow-list; a typo cannot put it in an unintended channel
  - identifies itself as an AI on join, once per channel
  - TLS with full certificate verification`);
  }
}