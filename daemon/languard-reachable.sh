#!/data/data/com.termux/files/usr/bin/bash
# Confirm, from the phone, which LAN-bound ports are actually REACHABLE.
#
# Why this exists. languard reports a port as "REACHABLE FROM THE LAN" purely
# because its bind address is 0.0.0.0 or ::. That is not the same thing as
# reachable, and the difference matters: the Windows Firewall filters inbound
# traffic independently of what a service binds to.
#
# Measured on this PC: spoolsv binds :::49580 and 0.0.0.0:49580, so languard
# reported it as a new LAN-reachable port. From the phone, port 49580 TIMES OUT
# while port 22 connects immediately. So the firewall is doing its job and the
# port is bound but not reachable.
#
# Both facts are true and neither is the whole truth:
#   - "bound to all interfaces" is a configuration fact, and languard is right
#   - "answering packets from the network" is an operational fact, and here it is
#     no
# A watcher that only knows the first will cry wolf about every dynamic RPC port
# Windows opens, which is exactly how a real alert gets ignored.
#
#   ./daemon/languard.sh reachable 22,49580,445,139

set -uo pipefail

PC_HOST="${PC_HOST:?set PC_HOST to the address of your machine}"
PORTS="${*:-22}"

node -e '
const net = require("net");
const host = process.argv[1];
const ports = process.argv.slice(2).map(Number);

let done = 0;
const finish = () => { if (++done === ports.length) process.exit(0); };

for (const p of ports) {
  const s = net.connect({ host, port: p });
  let verdict = "unknown";
  const settle = (v) => {
    verdict = v;
    console.log(`  ${String(p).padEnd(6)} ${v}`);
    try { s.destroy(); } catch {}
    finish();
  };
  s.setTimeout(5000);
  s.on("connect", () => settle("OPEN     -- reachable from the LAN"));
  s.on("timeout", () => settle("filtered -- bound but firewalled off"));
  s.on("error", (e) => settle(e.code === "ECONNREFUSED" ? "closed   -- nothing listening"
                                                       : `blocked  -- ${e.code}`));
}
' "$PC_HOST" $PORTS

# Interpret: an open port is a finding; a filtered one is configuration worth
# knowing but not an exposure. Say which, because they call for different
# actions and conflating them is how a report becomes noise.
echo ""
echo "OPEN     = reachable by anything on the LAN. Act on it."
echo "filtered = a service is bound to all interfaces but the firewall blocks it."
echo "           Not currently exposed; worth knowing if the firewall changes."
echo "closed   = nothing listening."