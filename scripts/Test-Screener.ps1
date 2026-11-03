# Sends one eval document to Gemini with the Worker's own prompt and schema (worker/src/screener-spec.json),
# and prints the verdict next to the answer key's. For iterating on the prompt before it's wired in.
# The API key is read from Credential Manager and sent as a header, never printed or put in a URL.
# Usage:  .\scripts\Test-Screener.ps1 -File doc-0003.pdf
# -Set dev (default) is for prompt tuning. -Set test is the held-out Phase 4 set: run it on purpose, not by habit.
param(
    [Parameter(Mandatory)][string]$File,
    [ValidateSet("dev", "test")][string]$Set = "dev"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. "$PSScriptRoot\GatewayCredential.ps1"

$root     = Resolve-Path "$PSScriptRoot\.."
$spec     = Get-Content "$root\worker\src\screener-spec.json" -Raw | ConvertFrom-Json
$setRoot  = if ($Set -eq "dev") { "$root\eval\dev" } else { "$root\eval" }
$manifest = Get-Content "$setRoot\manifest.json" -Raw | ConvertFrom-Json

$doc = $manifest.documents | Where-Object file -eq $File
if (-not $doc) { throw "$File is not in the manifest." }
$pdf = Get-ChildItem "$setRoot\out" -Recurse -Filter $File | Select-Object -First 1
if (-not $pdf) { throw "Can't find $File in the $Set set." }
$bytes = [IO.File]::ReadAllBytes($pdf.FullName)

# The same two facts the Worker will send: the filed type and the applicant's name.
$soql = "SELECT Applicant_Name__c FROM Application__c WHERE Id = '$($doc.application_id)'"
$name = (sf data query -o gatewayDev -q $soql --json | ConvertFrom-Json).result.records[0].Applicant_Name__c
$type = $doc.slot_type -replace '_', ' '
$user = $spec.userTemplate.Replace('{type}', $type).Replace('{name}', $name)

# Document properties live in the file but never reach the model as page content, so they're passed explicitly.
# Reads literal strings from the uncompressed Info dictionary; properties inside compressed streams aren't seen.
$raw   = [Text.Encoding]::Latin1.GetString($bytes)
$props = @([regex]::Matches($raw, '/(Title|Subject|Keywords|Author|Creator|Producer)\s*\(((?:\\.|[^\\)])*)\)') |
    ForEach-Object { "$($_.Groups[1].Value): $($_.Groups[2].Value -replace '\\(.)', '$1')" } |
    Select-Object -Unique)

$parts = @(
    @{ inline_data = @{ mime_type = "application/pdf"; data = [Convert]::ToBase64String($bytes) } },
    @{ text = $user }
)
if ($props.Count -gt 0) { $parts += @{ text = $spec.propertiesTemplate.Replace('{properties}', ($props -join "`n")) } }

$body = @{
    systemInstruction = @{ parts = @(@{ text = $spec.system }) }
    contents          = @(@{ role = "user"; parts = $parts })
    generationConfig  = @{ responseMimeType = "application/json"; responseSchema = $spec.responseSchema }
} | ConvertTo-Json -Depth 20 -Compress

$key = (Get-GatewayCredential -Target "SafeDocumentIntake-Gemini").GetNetworkCredential().Password
try {
    $resp = Invoke-RestMethod -Method Post `
        -Uri "https://generativelanguage.googleapis.com/v1beta/models/$($spec.model):generateContent" `
        -Headers @{ "x-goog-api-key" = $key } -ContentType "application/json" -Body $body
} catch {
    Write-Host "Gemini call FAILED: $($_.Exception.Response.StatusCode.value__)"
    Write-Host $_.ErrorDetails.Message
    return
} finally {
    Remove-Variable key
}

# Thinking models can return thought parts; the answer is the first non-thought text part.
$text = ($resp.candidates[0].content.parts | Where-Object { $_.text -and -not $_.thought } | Select-Object -First 1).text
$out = $text | ConvertFrom-Json

$match = if ($out.verdict -eq $doc.expected_verdict) { "MATCH" } else { "MISS" }
Write-Host "File      : $File ($($doc.category), $($doc.rendering)$(if ($doc.injection_style) { ", $($doc.injection_style)" }))"
Write-Host "Filed as  : $type"
Write-Host "Expected  : $($doc.expected_verdict)"
Write-Host "Verdict   : $($out.verdict)   $match"
Write-Host "Detected  : $($out.detected_type)"
Write-Host "Tampering : $($out.tampering_detected)"
if ($out.tampering_excerpt) { Write-Host "Excerpt   : $($out.tampering_excerpt)" }
Write-Host "Reasons   : $($out.reasons) [$($out.reasons.Length) chars]"
Write-Host "Tokens    : $($resp.usageMetadata.promptTokenCount) in, $($resp.usageMetadata.candidatesTokenCount) out"
Write-Host "Properties: $($props.Count) passed"