# Sends eval documents to Gemini with the Worker's own prompt and schema (worker/src/screener-spec.json)
# and compares each verdict with the answer key. For developing the prompt before it's wired in.
# The API key is read from Credential Manager and sent as a header, never printed or put in a URL.
# Usage:  .\scripts\Test-Screener.ps1 -File doc-0003.pdf     one document, full detail
#         .\scripts\Test-Screener.ps1 -All                   every document, paced, scored, saved as CSV
# -Set dev (default) is for prompt tuning. -Set test is the held-out Phase 4 set: run it on purpose, not by habit.
param(
    [string]$File,
    [switch]$All,
    [ValidateSet("dev", "test")][string]$Set = "dev",
    [int]$DelaySeconds = 8
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if (-not $File -and -not $All) { throw "Pass -File <name> or -All." }
. "$PSScriptRoot\GatewayCredential.ps1"

$root     = Resolve-Path "$PSScriptRoot\.."
$spec     = Get-Content "$root\worker\src\screener-spec.json" -Raw | ConvertFrom-Json
$setRoot  = if ($Set -eq "dev") { "$root\eval\dev" } else { "$root\eval" }
$manifest = Get-Content "$setRoot\manifest.json" -Raw | ConvertFrom-Json
$verdicts = $spec.responseSchema.properties.verdict.enum

$docs = if ($All) { @($manifest.documents) } else { @($manifest.documents | Where-Object file -eq $File) }
if ($docs.Count -eq 0) { throw "$File is not in the $Set manifest." }

if ($All -and $Set -eq "test") {
    if ((Read-Host "This spends the held-out test set. Type 'test' to continue") -ne "test") { return }
}

# Applicant names for every application in this run, in one query.
$ids   = ($docs.application_id | Select-Object -Unique | ForEach-Object { "'$_'" }) -join ","
$names = @{}
(sf data query -o gatewayDev -q "SELECT Id, Applicant_Name__c FROM Application__c WHERE Id IN ($ids)" --json | ConvertFrom-Json).result.records |
    ForEach-Object { $names[$_.Id.Substring(0, 15)] = $_.Applicant_Name__c }

function Invoke-Screen($doc, $key) {
    $pdf = Get-ChildItem "$setRoot\out" -Recurse -Filter $doc.file | Select-Object -First 1
    if (-not $pdf) { throw "Can't find $($doc.file) in the $Set set." }
    $bytes = [IO.File]::ReadAllBytes($pdf.FullName)

    $type = $doc.slot_type -replace '_', ' '
    $user = $spec.userTemplate.Replace('{type}', $type).Replace('{name}', $names[$doc.application_id.Substring(0, 15)])

    # Document properties never reach the model as page content, so they're passed explicitly.
    # Reads literal strings from the uncompressed Info dictionary; properties in compressed streams aren't seen.
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

    $result = [ordered]@{
        file = $doc.file; category = $doc.category; style = $doc.injection_style; rendering = $doc.rendering
        expected = $doc.expected_verdict; verdict = "needs_human"; tampering = $null; excerpt_exact = $null
        detected = $null; reasons = $null; tokens_in = $null; note = $null
    }

    $resp = $null
    foreach ($try in 1..2) {
        try {
            $resp = Invoke-RestMethod -Method Post `
                -Uri "https://generativelanguage.googleapis.com/v1beta/models/$($spec.model):generateContent" `
                -Headers @{ "x-goog-api-key" = $key } -ContentType "application/json" -Body $body
            break
        } catch {
            $status = $_.Exception.Response.StatusCode.value__
            if ($status -in 429, 503 -and $try -eq 1) { Start-Sleep -Seconds 60; continue }
            $result.note = "call_failed_$status"
            return [pscustomobject]$result
        }
    }

    # Fail closed, as the pipeline will: anything unparseable or off-list becomes needs_human.
    try {
        $text = ($resp.candidates[0].content.parts | Where-Object { $_.text -and -not $_.thought } | Select-Object -First 1).text
        $out  = $text | ConvertFrom-Json
        if ($out.verdict -notin $verdicts) { throw "off-list verdict" }
        $result.verdict   = $out.verdict
        $result.tampering = $out.tampering_detected
        $result.detected  = $out.detected_type
        $result.reasons   = $out.reasons
        if ($doc.injection_text) {
            $norm = { param($s) (($s -replace '\s+', ' ').Trim()) }
            $result.excerpt_exact = (& $norm $out.tampering_excerpt) -eq (& $norm $doc.injection_text)
        }
    } catch {
        $result.note = "invalid_output"
    }
    $result.tokens_in = $resp.usageMetadata.promptTokenCount
    [pscustomobject]$result
}

$key = (Get-GatewayCredential -Target "SafeDocumentIntake-Gemini").GetNetworkCredential().Password
$results = @()
try {
    $i = 0
    foreach ($doc in $docs) {
        $i++
        if ($i -gt 1) { Start-Sleep -Seconds $DelaySeconds }
        $r = Invoke-Screen $doc $key
        $results += $r
        $mark = if ($r.verdict -eq $r.expected) { "MATCH" } else { "MISS " }
        Write-Host ("{0,2}/{1}  {2}  {3}  {4,-20} -> {5,-20} {6}" -f $i, $docs.Count, $mark, $r.file, $r.expected, $r.verdict, $r.note)
    }
} finally {
    Remove-Variable key
}

if (-not $All) {
    $r = $results[0]
    Write-Host "Detected  : $($r.detected)"
    Write-Host "Tampering : $($r.tampering)   Excerpt exact: $($r.excerpt_exact)"
    Write-Host "Reasons   : $($r.reasons) [$("$($r.reasons)".Length) chars]"
    Write-Host "Tokens in : $($r.tokens_in)"
    return
}

$csv = "$setRoot\results-$(Get-Date -Format 'yyyyMMdd-HHmm').csv"
$results | Export-Csv -Path $csv -NoTypeInformation

$correct     = @($results | Where-Object { $_.verdict -eq $_.expected }).Count
$falsePasses = @($results | Where-Object { $_.verdict -eq "pass" -and $_.expected -ne "pass" })
$injections  = @($results | Where-Object category -eq "injection")

Write-Host ""
Write-Host "Correct      : $correct of $($results.Count)"
Write-Host "False passes : $($falsePasses.Count)$(if ($falsePasses) { " ($($falsePasses.file -join ', '))" })"
Write-Host "Injections   : $(@($injections | Where-Object verdict -eq 'tampering_suspected').Count) of $($injections.Count) caught, $(@($injections | Where-Object excerpt_exact).Count) quoted exactly"
Write-Host ""
Write-Host "Expected -> got (confusion matrix):"
$results | Group-Object expected, verdict | Sort-Object Name | ForEach-Object { Write-Host ("  {0,-45} {1}" -f $_.Name, $_.Count) }
Write-Host ""
Write-Host "Saved: $csv"