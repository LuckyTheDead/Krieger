# Home security system — start here

Built 2026-10-02 from the phone (Termux) and the PC (Windows, reachable by SSH).

## What actually exists

**Sensors on the PC, measured not assumed:**

| capability        | state                                              |
|-------------------|----------------------------------------------------|
| camera            | Integrated Webcam, `USB\VID_0C45&PID_6A00`, status OK |
| camera output     | 91 frames in 3s (full 30fps) — genuinely streaming   |
| camera IMAGE      | **every pixel zero.** Pure black, in every frame      |
| camera privacy    | Allow in HKCU, HKLM, and NonPackaged                 |
| audio             | HD Audio, Intel Display Audio (siren capable)        |
| GPIO / sensors    | **none.** No Arduino, FTDI, CP210, or GPIO            |
| sleep             | AC timeout 0x0 — never sleeps, good for always-on     |
| network           | &lt;the watched machine&gt;, wired Ethernet            |
| admin rights      | yes (Administrators), so ACLs and services are possible |

The camera is live: it streams 91 frames in 3s at full 30fps, status OK,
privacy Allow, and now returns real image content (mean luma 88-117, YMAX 255).
It was briefly returning pure black; the correction is written up below because
the reasoning error is more useful than the fix.

## Why the camera looked black — and the correction

**This section previously concluded the camera was physically shuttered or dead.
That was wrong.** The user could see the camera and reported it fine; re-measuring
confirmed it. The record is kept because the reasoning error is worth
remembering, not because the conclusion was right.

What was measured, both times, with the same code on the PC:

| | frames | bytes/frame | mean luma | YMAX |
|---|---|---|---|---|
| first attempt | 12 | 387–400 | **0** | 0 |
| after the user said it was fine | 12 | 2688–2921 | **88–117** | 255 |
| single frame over plain SSH, both times | 1 | 387 → **16,087** | **0 → 23.7** | **255** |

The pipeline was always fine — the device opens, streams at full 30fps (91
frames in 3s), status OK, privacy Allow. What changed is the camera's actual
output. No reboot occurred (`LastBootUpTime` 2026-09-24), so nothing restarted:
the lid was opened, a shutter was slid back, or a screen that had been lighting
the scene went away.

**The reasoning error.** I had three methods agreeing — mean brightness 0,
`signalstats` all-zero, and a reference grey image reading 128 through the same
code path. I treated that as independent confirmation of a hardware fault. It was
not: all three measured **pixel values**, so they agreed because they were the
same measurement, not because three different facts supported the diagnosis.
"Every pixel is zero" was a true observation; "therefore the lens is covered" was
a guess past the end of the evidence, presented to the user as settled.

The rule for next time: when a measurement points at hardware, report what was
measured and what remains possible, and ask the person who can see the device.
A diagnosis the user can contradict from across the room should not be closed
from a distance.

## What is built and working

| piece | state | how to check |
|---|---|---|
| LAN exposure watcher | **running**, on every boot | `./daemon/languard.sh status` / `diff` |
| Motion detection | **running every 5 min** on the PC | `type C:\Users\${PC_USER}\camwatch.log` |
| Security-event watcher | **running every 2 min** on the PC | `type C:\Users\${PC_USER}\logwatch.log` |
| Sensor inventory | on demand | `pc-sensors.ps1` |
| Disk-encryption assessment | on demand | `bitlocker-report.ps1` |
| All-of-the-above status | on demand | `security-status.ps1` |
| One-shot bring-up | on demand | `security-bringup.bat` |

### The two halves of the problem

The exposure watcher covers **configuration** -- a new listening port. The
security-event watcher covers **access** -- logons, account and group changes,
service installs, privilege escalation, and a cleared audit log. Both matter and
neither substitutes for the other: on a machine with BitLocker off and SMB
reachable on every interface, someone can log in successfully without any port
changing at all.

Watched ids: 1102 (audit log cleared), 4624/4625 (logon, failed), 4672 (special
privileges), 4720/4726 (account created/deleted), 4728/4732 (group membership),
7045 (service installed).

Measured here: 27k Security records, Circular at 20 MB, log advancing. Today's 17
failed logons are all mine -- FakeUser logon-type-8 entries at 16:19-16:20 from my
own SSH setup tests. No external attempts.

**Retention is a real limit.** Circular at 20 MB with this volume is a window of
days, not weeks. Reading the log after the fact has a deadline.

### Verified, and not verified

Verified against real hardware: the camera's MOTION/STILL/NO_SIGNAL judgements
(synthetic frames, 3/3), the guard firing on genuinely dark real frames, and the
hardware-to-judge chain end to end (cam-pipeline-check.ps1).

Not verified: the live MOTION path on real footage -- it needs a moving person in
a lit room. And the specific 4625 detection, because a remote script cannot
produce a failed logon on demand; three different attempts all logged nothing.

The motion watcher is a scheduled task (`KriegerCamWatch`, every 5 min) writing
one **verdict** per check to `C:\Users\${PC_USER}\camwatch.log`, not just a frame
count. Verified end to end through the scheduled task itself, not just
interactively:

```
Sat 10/03/2026  0:24:34.85 VERDICT=NO_SIGNAL frames=10 median=0.1
```

Two separate test suites exist on purpose. `daemon/cammotion.test.sh` proves the
phone-side judging path (4/4). `cam-judge-test.ps1` on the PC proves all three
verdicts against synthetic frames with known ground truth — moving block must
read MOTION, static scene STILL, black scene NO_SIGNAL — 3/3, no camera and no
human needed. It disables the watcher first, because the task overwrites the
frames directory between generating and judging, which is exactly what made the
first attempt read the wrong thing.

The `NO_SIGNAL` in live logs around 00:2x is not a fault: the room lights are
off. That is precisely the case the guard exists for, and it is why a detector
answering only "motion / no motion" would have logged "all quiet".

## The best next step

1. **Decide on disk encryption, not SMB.** SMB is already firewalled off -- see
   the correction below, I had this wrong. What remains is physical: BitLocker
   is off and there is no TPM, so it needs a startup USB key at every boot.
   Either accept that deliberately, or enable it if the PC is always attended.
2. **Make the motion log useful.** It records frames-per-check; the next step is
   recording the MOTION/STILL/NO_SIGNAL verdict each time, so a pattern is
   visible without pulling frames. Right now the verdict happens on the phone,
   which means the unattended log cannot show it.
3. **Alerting to you.** The Termux:API bridge is dead, so phone notification is
   unavailable; the IRC channel is a working fallback the daemon already
   maintains — but an agent paging a public channel is your call, not mine.

## Correction: SMB and NetBIOS are NOT currently reachable

I previously reported 445 (SMB) and 139 (NetBIOS) as "reachable on every
interface", which reads as an open exposure. That was wrong, because I checked
the BIND ADDRESS and stopped there.

**Measured from the phone** -- the only vantage point that answers the question:

```
22     OPEN     -- reachable from the LAN
49580  filtered -- bound but firewalled off
445    filtered -- bound but firewalled off
139    filtered -- bound but firewalled off
135    filtered -- bound but firewalled off
```

And the reason, from `Get-NetFirewallProfile -PolicyStore ActiveStore`:

```
Domain    enabled=True  defaultInbound=Block
Private   enabled=True  defaultInbound=Block
Public    enabled=True  defaultInbound=Block
```

**The firewall denies inbound by default on every profile.** SMB is bound to all
interfaces and blocked in transit. Nothing on the LAN can reach it.

The earlier `Get-NetFirewallProfile` reported `DefaultInboundAction =
NotConfigured`, which was not an answer -- it means the effective value comes from
local policy rather than the profile default, so it needs `-PolicyStore
ActiveStore` to resolve. Reading the convenient column gave an ambiguous value.

| claim | status |
|---|---|
| 445/139 bound to 0.0.0.0 | true |
| 445/139 reachable from the LAN | **FALSE -- firewalled** |
| BitLocker off, disk unencrypted | true, unchanged |
| No TPM, so full BitLocker needs a USB key | true, unchanged |

The real residual risk is therefore **physical**: an unencrypted disk can be
removed and read. There is no firewall change that helps with that.

**What changed my assessment:** `daemon/languard-reachable.sh`, which probes from
the phone instead of trusting a bind address. A bind address is a *configuration*
fact; whether anything can connect is an *operational* fact. languard alone would
have cried wolf about every dynamic RPC port Windows opens -- it did exactly that
for spoolsv on 49580 -- which is how a real alert gets ignored.

## Disk encryption: measured, and the answer is not obvious

```
C:            protection=Off  status=FullyDecrypted  encryption=0%
TPM present   False
AD key escrow none (no domain)
C: free       616.5 GB of 689.1 GB
```

**There is no TPM on this machine.** Without one, BitLocker cannot auto-unlock at
boot, so it requires a **startup key on removable media**: a USB stick present at
every boot, or the PC does not boot. On a desktop nobody physically attends, that
is a real way to end up with an unbootable machine. No Active Directory either, so
no automatic recovery-key escrow -- and saving the key to a file on the disk being
encrypted would be pointless.

So the recommendation is not "turn on BitLocker tonight":

- If the PC is always attended, BitLocker with a startup key is reasonable.
- If it is not, the network side is already handled by the firewall, so the
  residual risk is purely physical.

Either way it is the user's call. Nothing has been changed.

## Files

- `daemon/languard.sh` — LAN exposure watcher (snapshot | diff | watch | status)
- `daemon/languard.test.sh` — 8 checks, including "does it stay quiet on no change"
- `daemon/scripts/languard-listeners.ps1` — the PC-side port inventory
- `daemon/scripts/bitlocker-report.ps1` — read-only disk-encryption assessment
- `daemon/scripts/pc-sensors.ps1` — sensor inventory
- `daemon/scripts/camera-grab.ps1` — single frame, tries several device names
- `daemon/scripts/camera-burst.ps1` — 12-frame burst for offline analysis
- `daemon/scripts/cam-diagnose.ps1` — device state, privacy, frame-rate probe
- `daemon/scripts/cam-session-install.ps1` — registers `KriegerCamGrab`
- `daemon/scripts/install-ffmpeg.ps1` — static ffmpeg, no installer, no admin
- `daemon/pc.sh`, `daemon/pcdispatch.sh` — transport and job dispatch