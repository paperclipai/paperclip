param(
  [int]$Port = 11435,
  [string]$Target = "http://127.0.0.1:11434",
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$statusPath = Join-Path $repo ".hermes-ollama-bridge-status.json"
$logPath = Join-Path $repo ".hermes-ollama-bridge.log"
$errorLogPath = Join-Path $repo ".hermes-ollama-bridge-error.log"
$scriptPath = Join-Path $PSScriptRoot "hermes-ollama-bridge.mjs"

function Get-WslHostAddress {
  $route = & wsl.exe -d Ubuntu -- ip route 2>$null
  $line = $route | Where-Object { $_ -match "^default via " } | Select-Object -First 1
  if ($line -match "^default via ([0-9.]+)") {
    return $Matches[1]
  }
  return "127.0.0.1"
}

function Test-HttpOk($url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 5
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

$hostAddress = Get-WslHostAddress
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq $hostAddress -or $_.LocalAddress -eq "0.0.0.0" -or $_.LocalAddress -eq "::" } |
  Select-Object -First 1

if ($existing -and $Restart) {
  Stop-Process -Id $existing.OwningProcess -Force
  Start-Sleep -Seconds 1
  $existing = $null
}

if (-not (Test-HttpOk "$Target/api/tags")) {
  throw "Windows Ollama is not reachable at $Target. Start Ollama first, then retry."
}

if (-not $existing) {
  $arguments = @($scriptPath, "--host", $hostAddress, "--port", "$Port", "--target", $Target)
  Start-Process -FilePath "node" -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath
  Start-Sleep -Seconds 2
}

$wslUrl = "http://$hostAddress`:$Port"
$wslCheck = & wsl.exe -d Ubuntu -- curl -sS --max-time 5 "$wslUrl/api/tags" 2>$null
$ok = $LASTEXITCODE -eq 0 -and $wslCheck

$status = [ordered]@{
  ok = [bool]$ok
  bridgeUrl = $wslUrl
  openAiCompatibleBaseUrl = "$wslUrl/v1"
  target = $Target
  hostAddress = $hostAddress
  port = $Port
  checkedAt = (Get-Date).ToString("o")
}

$status | ConvertTo-Json | Set-Content -Path $statusPath -Encoding UTF8

if ($ok) {
  Write-Host "Hermes Ollama bridge OK: $wslUrl"
  Write-Host "OpenAI-compatible base URL: $wslUrl/v1"
} else {
  Write-Host "Hermes Ollama bridge is not reachable from WSL yet."
  Write-Host "Status report: $statusPath"
  exit 1
}
