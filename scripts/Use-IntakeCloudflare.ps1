# Points Wrangler at the personal Cloudflare account using the Safe Document Intake token, for this session only.
# Reads the account ID (username) and scoped API token (password) from Credential Manager
# (target: SafeDocumentIntake-CF). Usage:  . .\scripts\Use-IntakeCloudflare.ps1

. "$PSScriptRoot\GatewayCredential.ps1"

$cf = Get-GatewayCredential -Target "SafeDocumentIntake-CF"
$env:CLOUDFLARE_ACCOUNT_ID = $cf.UserName
$env:CLOUDFLARE_API_TOKEN  = $cf.GetNetworkCredential().Password
Remove-Variable cf

Write-Host "Wrangler now uses the Safe Document Intake token (this session only)."