$ErrorActionPreference = 'SilentlyContinue'
# What would enabling BitLocker on C: actually cost? Read-only: this reports,
# it does not change anything.
#
# The finding that prompted this: BitLocker is OFF while 445/SMB and 139/NetBIOS
# listen on every interface. That is a machine whose disk contents travel the
# network unencrypted and whose storage is readable if the disk is stolen. But
# enabling it is not free and not riskless -- it needs a recovery key, and if the
# key is lost the disk is unrecoverable. So measure before recommending.

Write-Output '=== current BitLocker state ==='
Get-BitLockerVolume | ForEach-Object {
  "  {0}  protection={1}  status={2}  encryption={3}" -f `
    $_.MountPoint, $_.ProtectionStatus, $_.VolumeStatus, $_.EncryptionPercentage
}

Write-Output ''
Write-Output '=== is there a TPM? (decides whether it can auto-unlock) ==='
$tpm = Get-Tpm -EA SilentlyContinue
if ($tpm) {
  "  TPM present=$($tpm.TpmPresent)  ready=$($tpm.TpmReady)  enabled=$($tpm.TpmEnabled)"
  if (-not $tpm.TpmReady) {
    Write-Output '  NOTE: TPM present but NOT ready. BitLocker would need TPM initialised first,'
    Write-Output '        which usually means a firmware/BIOS action.'
  }
} else {
  Write-Output '  no TPM reported (older BIOS, or disabled in firmware)'
}

Write-Output ''
Write-Output '=== what protectors would be available ==='
# Device encryption is the no-admin, no-requirement variant; full BitLocker needs
# either a TPM or a startup key on removable media.
$de = Get-CimInstance -Namespace root\cimv2\Security\MicrosoftTpm -ClassName Win32_Tpm -EA SilentlyContinue
"  Win32_Tpm present: $(if($de){'yes'}else{'no'})"

Write-Output ''
Write-Output '=== recovery key escrow: where would the key go? ==='
# This is the part that decides whether enabling is safe right now.
$ad = Get-CimInstance -Namespace root\directory\DS -ClassName msDS-KeyCredentialLink -EA SilentlyContinue
"  Active Directory key escrow configured: $(if($ad){'yes'}else{'no (no domain here, so no escrow)'})"
Write-Output '  -> Without AD, the recovery key must be saved by hand or to a file.'
Write-Output '     A file on THIS machine would be pointless: it is the disk being encrypted.'

Write-Output ''
Write-Output '=== free space (encryption needs room) ==='
Get-Volume -DriveLetter C | ForEach-Object {
  "  C: size={0:N1}GB free={1:N1}GB" -f ($_.Size / 1GB), ($_.SizeRemaining / 1GB)
}

Write-Output ''
Write-Output '=== SMB exposure, which is what makes the unencrypted disk reachable ==='
$smb = Get-SmbServerConfiguration
"  SMB1 enabled : $($smb.EnableSMB1Protocol)"
"  SMB2 enabled : $($smb.EnableSMB2Protocol)"
"  encryption   : $($smb.EncryptData)  (shares requiring encryption: $($smb.ForceEncryption))"
Write-Output '  shares:'
Get-SmbShare | Where-Object { $_.Name -notin @('ADMIN$','C$','IPC$') } |
  ForEach-Object { "    $($_.Name)  path=$($_.Path)  encrypt=$($_.EncryptData)" }
$adminShares = Get-SmbShare | Where-Object { $_.Name -in @('C$','ADMIN$') }
if ($adminShares) {
  Write-Output '  NOTE: administrative shares (C$, ADMIN$) are present, which means remote'
  Write-Output '        administrative access is possible for accounts that are permitted it.'
}