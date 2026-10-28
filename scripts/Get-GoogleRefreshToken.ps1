# One-time Google sign-in for Safe Document Intake. PowerShell 7.
#
# Gets a refresh token for the drive.file scope and stores it in Windows Credential Manager
# (target: SafeDocumentIntake-GoogleRefresh). The token is never printed or written to disk.
#
# Reads the OAuth client from Credential Manager (target: SafeDocumentIntake-Google,
# username = client ID, password = client secret).
#
# Flow: native-app OAuth (RFC 8252) with PKCE S256, a random state, and a loopback redirect on
# 127.0.0.1 caught by a raw TCP listener (no admin URL reservation needed), the same pattern as
# Connect-Gateway in the safe-agent-gateway repo.
#
# Usage (from the repo root):  .\scripts\Get-GoogleRefreshToken.ps1

. "$PSScriptRoot\GatewayCredential.ps1"

$ClientTarget  = "SafeDocumentIntake-Google"
$RefreshTarget = "SafeDocumentIntake-GoogleRefresh"
$Scope         = "https://www.googleapis.com/auth/drive.file"
$LoopbackPort  = 33419   # 33418 is Connect-Gateway's port
$RedirectUri   = "http://127.0.0.1:$LoopbackPort"

# --- Credential Manager writer (the reader lives in GatewayCredential.ps1) -----------------------

if (-not ('IntakeCred.Writer' -as [type])) {
    Add-Type -Namespace IntakeCred -Name Writer -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
}

[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredWrite(ref CREDENTIAL credential, int flags);
'@
}

function Set-IntakeCredential {
    param(
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$UserName,
        [Parameter(Mandatory)][string]$Secret
    )
    # Stored as UTF-16, which is what Get-GatewayCredential reads back.
    $blob = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni($Secret)
    try {
        $c = [IntakeCred.Writer+CREDENTIAL]::new()
        $c.Type               = 1   # CRED_TYPE_GENERIC
        $c.Persist            = 2   # CRED_PERSIST_LOCAL_MACHINE (survives logoff)
        $c.TargetName         = $Target
        $c.UserName           = $UserName
        $c.CredentialBlob     = $blob
        $c.CredentialBlobSize = $Secret.Length * 2
        if (-not [IntakeCred.Writer]::CredWrite([ref]$c, 0)) {
            throw "CredWrite failed (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))."
        }
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($blob)
    }
}

# --- Helpers ----------------------------------------------------------------------------------

function ConvertTo-Base64Url([byte[]]$Bytes) {
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-QueryString([string]$Query) {
    $result = @{}
    foreach ($pair in $Query.TrimStart('?').Split('&', [StringSplitOptions]::RemoveEmptyEntries)) {
        $kv = $pair.Split('=', 2)
        $value = if ($kv.Count -gt 1) { $kv[1] } else { '' }
        $result[[Uri]::UnescapeDataString($kv[0])] = [Uri]::UnescapeDataString($value.Replace('+', ' '))
    }
    $result
}

function Send-LoopbackResponse($Stream, [int]$Status, [string]$Html) {
    $reason = if ($Status -eq 200) { "OK" } else { "Not Found" }
    $body   = [Text.Encoding]::UTF8.GetBytes($Html)
    $head   = [Text.Encoding]::ASCII.GetBytes(
        "HTTP/1.1 $Status $reason`r`nContent-Type: text/html; charset=utf-8`r`n" +
        "Content-Length: $($body.Length)`r`nConnection: close`r`n`r`n")
    $Stream.Write($head, 0, $head.Length)
    $Stream.Write($body, 0, $body.Length)
    $Stream.Flush()
}

# --- 1. Build the authorization request -------------------------------------------------------

$client = Get-GatewayCredential -Target $ClientTarget

$verifier  = ConvertTo-Base64Url ([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$challenge = ConvertTo-Base64Url ([Security.Cryptography.SHA256]::HashData([Text.Encoding]::ASCII.GetBytes($verifier)))
$state     = ConvertTo-Base64Url ([Security.Cryptography.RandomNumberGenerator]::GetBytes(16))

$authParams = [ordered]@{
    client_id             = $client.UserName
    redirect_uri          = $RedirectUri
    response_type         = "code"
    scope                 = $Scope
    access_type           = "offline"   # ask for a refresh token
    prompt                = "consent"   # make Google issue one even if consent was given before
    code_challenge        = $challenge
    code_challenge_method = "S256"
    state                 = $state
}
$query   = ($authParams.GetEnumerator() | ForEach-Object { "$($_.Key)=$([Uri]::EscapeDataString($_.Value))" }) -join '&'
$authUrl = "https://accounts.google.com/o/oauth2/v2/auth?$query"

# --- 2. Listen on the loopback port, then open the browser ------------------------------------

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $LoopbackPort)
$listener.Start()
Write-Host "Opening the browser for Google sign-in. Use your personal Google account."
Start-Process $authUrl

$callback = $null
$deadline = (Get-Date).AddMinutes(5)
try {
    while (-not $callback) {
        if ((Get-Date) -gt $deadline) { throw "Timed out waiting for the Google sign-in (5 minutes)." }
        if (-not $listener.Pending()) { Start-Sleep -Milliseconds 200; continue }

        $tcp = $listener.AcceptTcpClient()
        try {
            $stream = $tcp.GetStream()
            $stream.ReadTimeout = 5000
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
            try { $requestLine = $reader.ReadLine() } catch { continue }   # read timed out
            if (-not $requestLine) { continue }   # Chrome opens empty speculative connections

            $target = $requestLine.Split(' ')[1]   # "GET /?state=...&code=... HTTP/1.1"
            if (-not $target.StartsWith('/?')) {
                Send-LoopbackResponse $stream 404 "Not found."
                continue
            }

            $params = ConvertFrom-QueryString $target.Substring(1)
            $page = "<html><body style='font-family:sans-serif;padding:2rem'>" +
                    "<h2>Safe Document Intake</h2><p>Sign-in received. You can close this tab.</p>" +
                    "<script>history.replaceState(null, '', '/done')</script></body></html>"
            Send-LoopbackResponse $stream 200 $page
            $callback = $params
        }
        finally {
            $tcp.Close()
        }
    }
}
finally {
    $listener.Stop()
}

# --- 3. Check the callback --------------------------------------------------------------------

if ($callback['error'])               { throw "Google returned an error: $($callback['error'])" }
if ($callback['state'] -ne $state)    { throw "State mismatch. Ignoring this response." }
if (-not $callback['code'])           { throw "No authorization code in the callback." }

# --- 4. Exchange the code for tokens ----------------------------------------------------------

$tok = Invoke-RestMethod -Method Post -Uri "https://oauth2.googleapis.com/token" -Body @{
    grant_type    = "authorization_code"
    code          = $callback['code']
    redirect_uri  = $RedirectUri
    client_id     = $client.UserName
    client_secret = $client.GetNetworkCredential().Password
    code_verifier = $verifier
}

try {
    if (-not $tok.refresh_token) {
        throw "Google did not return a refresh token. Remove the app's access at " +
              "https://myaccount.google.com/permissions and run this script again."
    }

    # Least privilege check: the grant must be drive.file and nothing else.
    $granted = @($tok.scope -split ' ' | Where-Object { $_ })
    if ($granted.Count -ne 1 -or $granted[0] -ne $Scope) {
        throw "Unexpected scopes granted: $($granted -join ', '). Expected only $Scope."
    }

    Set-IntakeCredential -Target $RefreshTarget -UserName "google-refresh-token" -Secret $tok.refresh_token
    Write-Host "Refresh token stored in Credential Manager ($RefreshTarget). Scope granted: drive.file only."
}
finally {
    Remove-Variable tok, client, verifier, callback -ErrorAction SilentlyContinue
}