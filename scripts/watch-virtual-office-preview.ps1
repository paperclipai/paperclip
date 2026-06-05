param(
  [int]$DurationMinutes = 120,
  [int]$IntervalSeconds = 60
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$reportPath = Join-Path $repoRoot ".virtual-office-stability-report.json"
$backendUrl = "http://127.0.0.1:3100/api/health"
$frontendUrl = "http://localhost:5173/AI/office"
$heartbeatEnabled = if ($env:HEARTBEAT_SCHEDULER_ENABLED) { $env:HEARTBEAT_SCHEDULER_ENABLED } else { "false" }

Write-Host "Virtual Office stability watcher"
Write-Host "Duration: $DurationMinutes minute(s)"
Write-Host "Interval: $IntervalSeconds second(s)"
Write-Host "Heartbeat scheduler: $heartbeatEnabled"
Write-Host "Report: $reportPath"
Write-Host ""

if ($DurationMinutes -lt 1) {
  throw "DurationMinutes must be at least 1."
}
if ($IntervalSeconds -lt 5) {
  throw "IntervalSeconds must be at least 5."
}

$startedAt = Get-Date
$deadline = $startedAt.AddMinutes($DurationMinutes)
$samples = New-Object System.Collections.Generic.List[object]

function Test-Url($Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 10
    return [pscustomobject]@{
      ok = $true
      statusCode = [int]$response.StatusCode
      error = $null
    }
  } catch {
    return [pscustomobject]@{
      ok = $false
      statusCode = $null
      error = $_.Exception.Message
    }
  }
}

while ((Get-Date) -lt $deadline) {
  $now = Get-Date
  $backend = Test-Url $backendUrl
  $frontend = Test-Url $frontendUrl
  $sample = [pscustomobject]@{
    checkedAt = $now.ToString("o")
    backendOk = $backend.ok
    backendStatusCode = $backend.statusCode
    backendError = $backend.error
    frontendOk = $frontend.ok
    frontendStatusCode = $frontend.statusCode
    frontendError = $frontend.error
    heartbeatSchedulerEnabled = $heartbeatEnabled
  }
  $samples.Add($sample)

  $backendText = if ($backend.ok) { "OK" } else { "blocked" }
  $frontendText = if ($frontend.ok) { "OK" } else { "blocked" }
  Write-Host ("[{0}] Backend {1}; Frontend {2}" -f $now.ToString("HH:mm:ss"), $backendText, $frontendText)

  Start-Sleep -Seconds $IntervalSeconds
}

$failedSamples = @($samples | Where-Object { -not $_.backendOk -or -not $_.frontendOk })
$summary = [pscustomobject]@{
  startedAt = $startedAt.ToString("o")
  finishedAt = (Get-Date).ToString("o")
  durationMinutes = $DurationMinutes
  intervalSeconds = $IntervalSeconds
  sampleCount = $samples.Count
  failedSampleCount = $failedSamples.Count
  backendUrl = $backendUrl
  frontendUrl = $frontendUrl
  heartbeatSchedulerEnabled = $heartbeatEnabled
  status = if ($failedSamples.Count -eq 0) { "pass" } else { "needs_review" }
  samples = $samples
}

$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $reportPath

Write-Host ""
Write-Host "Stability summary"
Write-Host ("  Status: {0}" -f $summary.status)
Write-Host ("  Samples: {0}" -f $summary.sampleCount)
Write-Host ("  Failed samples: {0}" -f $summary.failedSampleCount)
Write-Host ("  Report: {0}" -f $reportPath)

if ($failedSamples.Count -gt 0) {
  exit 1
}
