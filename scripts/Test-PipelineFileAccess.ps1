# Probes what the intake pipeline user can do with Files, through a real client-credentials token.
# Prints status codes, sizes and counts only: never the token, the secret or file contents.
# Usage:  .\scripts\Test-PipelineFileAccess.ps1 -ContentVersionId 068...
param([Parameter(Mandatory)][string]$ContentVersionId)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # The progress bar can overwrite result lines.
. "$PSScriptRoot\GatewayCredential.ps1"

$project  = Get-Content "$PSScriptRoot\..\sfdx-project.json" -Raw | ConvertFrom-Json
$api      = "v$($project.sourceApiVersion)"
$instance = (sf org display -o gatewayDev --json | ConvertFrom-Json).result.instanceUrl

function Show-Failure($label) {
    $status = $_.Exception.Response.StatusCode.value__
    $code = try { ($_.ErrorDetails.Message | ConvertFrom-Json)[0].errorCode } catch { "unknown" }
    Write-Host "$label : FAILED ($status $code)"
}

# Token: the secret lives only inside this block.
$cred = Get-GatewayCredential -Target "SafeDocumentIntake-SF"
$form = @{
    grant_type    = "client_credentials"
    client_id     = $cred.UserName
    client_secret = $cred.GetNetworkCredential().Password
}
Remove-Variable cred
try {
    $token = Invoke-RestMethod -Method Post -Uri "$instance/services/oauth2/token" -Body $form -ContentType "application/x-www-form-urlencoded"
} finally {
    Remove-Variable form
}
$headers = @{ Authorization = "Bearer $($token.access_token)" }
Write-Host "Token issued, scope: $($token.scope)"
Remove-Variable token

$base = "$instance/services/data/$api"

# 1. Metadata for the target file (no Title, since a file name can describe a person).
try {
    $meta = Invoke-RestMethod -Uri "$base/sobjects/ContentVersion/$ContentVersionId`?fields=ContentSize,FileExtension" -Headers $headers
    Write-Host "Metadata : OK ($($meta.FileExtension), $($meta.ContentSize) bytes)"
} catch { Show-Failure "Metadata" }

# 2. Download the bytes into memory only, and check they're really a PDF.
try {
    $resp  = Invoke-WebRequest -Uri "$base/sobjects/ContentVersion/$ContentVersionId/VersionData" -Headers $headers
    $bytes = $resp.Content
    $magic = [Text.Encoding]::ASCII.GetString($bytes, 0, [Math]::Min(5, $bytes.Length))
    Write-Host "Download : OK ($($bytes.Length) bytes, starts with '$magic')"
    Remove-Variable resp, bytes
} catch { Show-Failure "Download" }


Remove-Variable headers