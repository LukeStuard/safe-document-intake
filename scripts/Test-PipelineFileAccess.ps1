# Probes what the intake pipeline user can do, through a real client-credentials token.
# Prints status codes, sizes, counts and picklist values only: never the token, the secret,
# file contents or an applicant's name.
# Usage:  .\scripts\Test-PipelineFileAccess.ps1 -ContentVersionId 068...
#         .\scripts\Test-PipelineFileAccess.ps1 -ChecklistItemId a02...
param(
    [string]$ContentVersionId,
    [string]$ChecklistItemId,
    [switch]$ListFiles
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # The progress bar can overwrite result lines.
if (-not $ContentVersionId -and -not $ChecklistItemId -and -not $ListFiles) { throw "Pass -ContentVersionId, -ChecklistItemId and/or -ListFiles." }

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

function Invoke-Query($soql) {
    Invoke-RestMethod -Uri "$base/query?q=$([uri]::EscapeDataString($soql))" -Headers $headers
}

if ($ContentVersionId) {
    # Metadata for the target file (no Title, since a file name can describe a person).
    try {
        $meta = Invoke-RestMethod -Uri "$base/sobjects/ContentVersion/$ContentVersionId`?fields=ContentSize,FileExtension" -Headers $headers
        Write-Host "Metadata : OK ($($meta.FileExtension), $($meta.ContentSize) bytes)"
    } catch { Show-Failure "Metadata" }

    # Download the bytes into memory only, and check they're really a PDF.
    try {
        $resp  = Invoke-WebRequest -Uri "$base/sobjects/ContentVersion/$ContentVersionId/VersionData" -Headers $headers
        $bytes = $resp.Content
        $magic = [Text.Encoding]::ASCII.GetString($bytes, 0, [Math]::Min(5, $bytes.Length))
        Write-Host "Download : OK ($($bytes.Length) bytes, starts with '$magic')"
        Remove-Variable resp, bytes
    } catch { Show-Failure "Download" }
}

if ($ChecklistItemId) {
    # The exact query the Worker uses to name folders and files.
    try {
        $r = (Invoke-Query "SELECT Document_Type__c, Application__c, Application__r.Term__c, Application__r.Applicant_Folder_Name__c FROM Checklist_Item__c WHERE Id = '$ChecklistItemId'").records[0]
        $folder = $r.Application__r.Applicant_Folder_Name__c
        $shape = if ($folder -match '^[^,]+, [^,]+$') { "Last, First shape" } else { "UNEXPECTED shape" }
        Write-Host "Fields   : OK (type '$($r.Document_Type__c)', term '$($r.Application__r.Term__c)', folder name $($folder.Length) chars, $shape)"
        Remove-Variable r, folder
    } catch { Show-Failure "Fields" }

    # Negative check: the formula must not open a path to the Contact itself.
    try {
        Invoke-Query "SELECT Application__r.Applicant__r.LastName FROM Checklist_Item__c WHERE Id = '$ChecklistItemId'" | Out-Null
        Write-Host "Contact  : REACHABLE (this should not happen)"
    } catch { Show-Failure "Contact  (expected)" }
}

if ($ListFiles) {
    # The reconciler's query: every checklist item with the latest version of each attached file. Counts only.
    try {
        $soql = "SELECT Id, (SELECT ContentDocument.LatestPublishedVersionId FROM ContentDocumentLinks) FROM Checklist_Item__c"
        $result = Invoke-Query $soql
        $pages = 1
        $records = @($result.records)
        while ($result.nextRecordsUrl) {
            $result = Invoke-RestMethod -Uri "$instance$($result.nextRecordsUrl)" -Headers $headers
            $records += $result.records
            $pages++
        }
        $withFiles = @($records | Where-Object { $_.ContentDocumentLinks })
        $versions = @($withFiles | ForEach-Object { $_.ContentDocumentLinks.records } | ForEach-Object { $_.ContentDocument.LatestPublishedVersionId } | Sort-Object -Unique)
        Write-Host "Files    : OK ($($records.Count) items, $($withFiles.Count) with files, $($versions.Count) latest versions, $pages page(s))"
        Remove-Variable result, records, withFiles, versions
    } catch { Show-Failure "Files" }
}

Remove-Variable headers