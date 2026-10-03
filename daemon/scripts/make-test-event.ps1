$ErrorActionPreference = 'SilentlyContinue'
# Produce a real 4625 failed-logon event, so the watcher's detection can be
# tested rather than assumed.
#
# The first attempt used PrincipalContext.ValidateCredentials, which raises
# without authenticating and logs nothing. A real failed logon needs a real
# authentication attempt, so use CreateProcessWithLogonW via runas.exe: it goes
# through LSA, fails on the bad password, and Windows records it.
#
# This creates no account and grants nothing: the user deliberately does not
# exist, so there is nothing to succeed as.

$user = "LogonWatchProbe_" + (Get-Random)
$pwd  = "not-the-password-" + (Get-Random)
Write-Output "target user: $user"

# runas.exe demands an interactive console for a real prompt, and /savecred
# does not exist on Windows. So drive LogonUser through P/Invoke instead, which
# is the same LSA path sshd and RDP use.
$code = @"
using System;
using System.Runtime.InteropServices;
public static class Lsa {
  [StructLayout(LayoutKind.Sequential)]
  public struct LSA_UNICODE_STRING {
    public ushort Length; public ushort MaximumLength;
    [MarshalAs(UnmanagedType.LPWStr)] public string Buffer;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct LSA_ATTRIBUTE {
    public int Length; [MarshalAs(UnmanagedType.LPWStr)] public string PointerToValue;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct LSA_LOGON_INFO {
    public LSA_UNICODE_STRING LogonDomainName;
    public LSA_UNICODE_STRING AuthenticationPackage;
    public LSA_UNICODE_STRING LogonUserName;
    public LSA_UNICODE_STRING DomainName;
    public LSA_UNICODE_STRING Password;
    public LSA_UNICODE_STRING Workstation;
    public uint LogonType; public uint CredHandleFlags;
    [MarshalAs(UnmanagedType.LPWStr)] public string AuthenticationInformation;
    public uint AuthenticationInformationLength;
    public LSA_ATTRIBUTE Attributes; public LSA_ATTRIBUTE ModifiedAttributes;
    public uint ReturnStatusFlags; public uint LogonSessionKeyLength;
    public IntPtr LogonSessionKey; public IntPtr CaseSensitive;
    public LSA_UNICODE_STRING SubAuthStatus;
  }
  [DllImport("secur32.dll", SetLastError = true)]
  static extern uint LogonUser(string user, string domain, string password,
    int logonType, string authPackage, IntPtr token, out IntPtr session,
    IntPtr credential, out uint returnStatus);
  [DllImport("kernel32.dll")] static extern uint GetLastError();

  public static string Try(string user, string password) {
    IntPtr tok, sess, cred;
    uint status;
    string domain = Environment.MachineName;
    uint r = LogonUser(user, domain, password, 3 /* LOGON32_LOGON_NETWORK */,
                       "", out tok, out sess, IntPtr.Zero, out status);
    if (r == 0) { return "failed GetLastError=" + GetLastError(); }
    return "UNEXPECTED SUCCESS";
  }
}
"@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
$res = [Lsa]::Try($user, $pwd)
Write-Output "LogonUser: $res"

Start-Sleep -Seconds 4

$since = (Get-Date).AddMinutes(-3)
$e = Get-WinEvent -FilterHashtable @{ LogName='Security'; Id=4625; StartTime=$since } -EA SilentlyContinue |
     Where-Object {
       try {
         $x = [xml]$_.ToXml()
         (($x.Event.EventData.Data | Where-Object { $_.Name -eq 'TargetUserName' }).'#text') -eq $user
       } catch { $false }
     }
if ($e) {
  Write-Output "EVENT-PRESENT: 4625 for $user, recordId=$($e[0].RecordId)"
  exit 0
} else {
  Write-Output "NO-EVENT: no 4625 appeared. Checking whether 4625 is auditable at all:"
  $pol = auditpol /get /subcategory:"Logon" 2>&1
  $pol | ForEach-Object { "  $_" }
  exit 1
}