#requires -Version 5.1
<#
  轮询 Paperclip dev：健康检查 + 可选 dev:list。日志默认写入仓库 .paperclip（已 gitignore）。

  仓库根：
    pwsh -NoProfile -File .\scripts\watch-paperclip-dev.ps1
    pwsh -NoProfile -File .\scripts\watch-paperclip-dev.ps1 -IntervalSec 8
  停止：在本终端 Ctrl+C
#>
param(
  [int]$IntervalSec = 12,
  [string]$HealthUrl = "http://127.0.0.1:3100/api/health",
  [string]$LogPath = "",
  [int]$ListEvery = 5
)

$ErrorActionPreference = "Continue"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $RepoRoot

if ([string]::IsNullOrWhiteSpace($LogPath)) {
  $LogPath = Join-Path $RepoRoot ".paperclip\dev-monitor.log"
}

$logDir = Split-Path -Parent $LogPath
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Mon([string]$Line) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $msg = "[$ts] $Line"
  Write-Host $msg
  try {
    Add-Content -LiteralPath $LogPath -Value $msg -Encoding utf8
  } catch {
    Write-Host "[watch] log write failed: $_" -ForegroundColor Red
  }
}

Write-Mon "watch-paperclip-dev start repo=$RepoRoot interval=${IntervalSec}s listEvery=$ListEvery"

$n = 0
while ($true) {
  $n += 1
  try {
    $j = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 8
    $rr = ""
    if ($j.devServer -and $j.devServer.restartRequired -eq $true) {
      $rr = " restartRequired=$($j.devServer.reason)"
    }
    $runs = if ($j.devServer) { $j.devServer.activeRunCount } else { "?" }
    Write-Mon "health ok status=$($j.status) activeRuns=$runs$rr"
  } catch {
    Write-Mon "health FAIL $($_.Exception.Message)"
  }

  if ($ListEvery -gt 0 -and ($n % $ListEvery) -eq 0) {
    try {
      $list = & pnpm dev:list 2>&1 | Out-String
      $one = ($list -split "`r?`n" | Where-Object { $_.Trim() -ne "" } | Select-Object -First 3) -join " | "
      Write-Mon "dev:list $one"
    } catch {
      Write-Mon "dev:list FAIL $($_.Exception.Message)"
    }
  }

  Start-Sleep -Seconds $IntervalSec
}
