#!/data/data/com.termux/files/usr/bin/bash
# Explicit delete list. Every path was inspected by hand before being added;
# nothing here is matched by a glob, so a surprise can only come from a typo.
#
# Kept deliberately (not game-related, or wanted):
#   Krieger-main.zip, krieger_helper_Version3.mjs   agent tooling
#   BattleTalent.apk, app-prod-release.apk           ambiguous (VR / browser),
#                                                     left alone not deleted
#   Thunderchild v411...zip                         Skyrim mod, not a game
#   *.jpg *.jpeg *.png *.gif *.wav                 photos, memes, cat
#   *.pdf *.json *.txt *.md *.HTML                  documents, journals
#   *.apk (non-game)  aware-phone, charluv-itch, F-Droid, NewPipe,
#                     vanced.*, LuckyPatchers, scrcpy tooling
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
DL="$HOME/storage/shared/Download"

TARGETS=(
  # --- big games: extracted folder + its own archive ---
  "Spiderwick Chronicles, The (USA)"
  "Spiderwick Chronicles, The (USA).7z"
  "Terraria"
  "Terraria (USA, Europe) (En,Fr,De,Es,It).7z"
  "Diablo III - Reaper of Souls + DLC [GOD]"
  "Terraria XBOX360 Edition"
  "Terraria XBOX360 Edition.rar"

  # --- other games / roms / hacks ---
  "GoldenEye 007 (USA)"
  "GoldenEye 007 (USA).zip"
  "Fire Emblem - The Sacred Stones (USA, Australia).zip"
  "Fire Emblem - The Sacred Stones (USA, Australia).gba"
  "Vision Quest v3.gba"
  "Vision Quest v3.ups"
  "Romhack.gba"
  "TRRIA-XBLA"
  "TRRIA-XBLA.rar"
  "BMOv3.1.gb"
  "FNaF GB v0.10.0 (DEMO 2).gb"
  "nazi-zombies-portable-psp.zip"
  "The_Cosmic_Glitch.zip"

  # --- MasterBoy / MasterBoy ROM + source ---
  "masterboy"
  "masterboy.7z"
  "MasterBoy2.0.rar"
  "MasterBoy2.0a.rar"
  "MasterBoy2.01.rar"
  "MasterBoy2.02.rar"
  "MasterBoy2.02Signed.zip"
  "MasterBoy_202_src.7z"
  "Masterboy2.02.rar"
  "Masterboy_20a_src.rar"

  # --- Xbox 360 tooling: extracts, homebrew, firmware ---
  "totalwar"
  "rome_total_war1_5.zip"
  "rome_totalwar_patch_13.zip"
  "SystemUpdate_17559_USB"
  "SystemUpdate_17559_USB.zip"
  "XeXMenu_v1.1-LIVE"
  "XeXMenu_v1.1-LIVE.7z"
  "XeUnshackle-BETA-v1_03"
  "XeUnshackle-BETA-v1_03.zip"
  "X-store-0.2.5-beta"
  "X-store-0.2.5-beta.zip"
  "XboxTLS.xex"
  "DashLaunch_v3.21"
  "DashLaunch_v3.21.7z"
  "RedPill.7z"
  "SotfV9Hotfix32.ups"
  "SmartSteamEmu147.7z"
  "hackxbox.zip"
  "nzportable"
  "bchunk.v1.2.1_repub.1.zip"

  # --- mikili (explicitly requested) ---
  "mikili"

  # --- emulators (game tooling by definition) ---
  "mGBA-0.10.5-appimage-x64.appimage"
  "gopher64-linux-x86_64"

  # --- game app packages ---
  "BitLife Life Simulator v3.23.6 Mod Oyunindir.club.apk"
)

for t in "${TARGETS[@]}"; do
  if [[ -e "$DL/$t" ]]; then
    sz=$(du -sh "$DL/$t" 2>/dev/null | awk '{print $1}')
    rm -rf "$DL/$t" && echo "removed $sz  $t"
  fi
done

echo "---"
du -sh "$DL"
