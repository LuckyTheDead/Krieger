# Online presence

An IRC presence, because IRC is the right shape for this: pseudonym-native, no
account infrastructure to maintain, and technical communities that expect
agents to declare themselves.

```sh
node daemon/ircbot.mjs networks              # known networks and their status
node daemon/ircbot.mjs test [network]        # connect, register, leave
node daemon/ircbot.mjs run '#debian' oftc    # join and listen

./daemon/irc-up.sh start|status|stop         # supervised, survives reboot
```

Currently live: **`krieger-bot` in #debian on OFTC**, over implicit TLS.

## Networks, as measured on this device (2026-10-01)

| network | host:port | result |
|---|---|---|
| **oftc** | `irc.oftc.net:6697` | works. Registered and joined #debian. |
| **libera** | `irc.libera.chat:6697` | reachable, but **bans undeclared bots**. |

Libera is not blocked by choice — it was measured. Connecting with a generic
nick produced:

```
:platinum.libera.chat 465 kriegerprobe :You are banned from this server- Your bot is not permitted to connect
:kriegerprobe QUIT :K-Lined
```

That arrives *after* a normal MOTD, so the connection looks healthy right up
until it isn't. Libera runs an explicit bot policy: registration is required
**before** connecting. `libera` is in `NETWORKS` with `requiresRegistration: true`
and the constructor **throws**, so it cannot be joined by accident or by
flipping a runtime flag.

OFTC is the open-source/FOSS network, which makes it the better audience as well
as the easier one.

## Two protocol details that cost real debugging

**Port 6697 is implicit TLS, not STARTTLS.** Established by experiment:

```
nc irc.oftc.net 6697          -> no output, connection reset
openssl s_client ...:6697     -> TLSv1.3, "Verify return code: 0 (ok)"
```

A raw ClientHello to 6697 came back as a TLS alert; 6667 answered the same probe
in plaintext IRC. That contrast is what identifies it. The first implementation
attempted STARTTLS on 6697 and got `ECONNRESET` every time; the second "fixed"
that by special-casing plain ports and made the port unreachable as well. Both
were wrong. The lesson worth keeping: **do not change working code because one
error message misled you** — verify the hypothesis separately first.

**`CAP LS` before `NICK`/`USER` stalls registration.** OFTC waits for a
registration that never arrives and never sends `001`, so the connect promise
never resolves. Registration is now `NICK`/`USER` first, `CAP LS` after the
welcome. Verified by tracing the wire: registration completes in about a second,
with `Connected securely via TLSv1.3`.

## The policy, enforced in code

Every rule below is a check in `say()` or `join()`, not a comment. No caller can
bypass them, because they are inside the functions that write to the socket.

- **Listens. Speaks only when asked directly.** Unprompted channel traffic throws
  unless the caller passes `reason: "reply"`.
- **Rate limit: 4 messages per rolling hour**, counted across all channels, so
  joining five channels does not multiply the allowance.
- **Channel allow-list.** A typo cannot put it in `#ops`. Filtered both in
  `join()` and in the constructor.
- **Refuses newlines in messages** — that is IRC command injection, where
  `hi\r\nJOIN #evil` makes the bot send a second command it was never told to.
- **Refuses empty messages.**
- **Discloses as an AI on join**, once per channel.
- **Full TLS certificate verification**, never disabled to "make it connect".

The reasoning behind "never speaks first": an agent that opens a conversation is
indistinguishable from a spam bot, and that is the entire reputation problem for
agents on IRC. A presence that is trusted to be quiet is worth having; one that
is not gets the whole network to ban it.

## What it will not do

It does not post to social media. Every major platform requires account
verification, phone numbers, and usually a real identity, and an agent posting
as a person is a different and considerably more invasive thing than joining a
technical channel under a name that says what it is. IRC gets the presence
without that.

If you want a written presence — a blog, a repo README, a package page — those
are static artifacts I can write, and they are the better fit for this anyway.

## Tests

17 tests, no network required — the socket is stubbed, so the suite is
hermetic. What is tested is the *policy*, because that is what decides whether
this is acceptable to run.

One test earned its keep by being wrong first: "channels outside the allow-list
are refused" originally asserted only that no exception was thrown, which
**passed while both channels were in fact being refused**. It now asserts on the
wire — that no `JOIN` was emitted. A green tick on a check that verifies nothing
is worse than a red one.