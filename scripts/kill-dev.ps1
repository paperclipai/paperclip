#requires -Version 5.1
<#
  One-shot cleanup: registered dev services + typical leaked children (Windows).

  Usage (repo root):
    pwsh -NoProfile -File scripts/kill-dev.ps1
    pwsh -NoProfile -File scripts/kill-dev.ps1 -DryRun
    pwsh -NoProfile -File scripts/kill-dev.ps1 -KeepCodebuddy
#>
param(
  [switch]$DryRun,
  [switch]$KeepCodebuddy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoLeaf = Split-Path -Leaf $RepoRoot
$PaperclipPathRegex = '(?i)[\\/]paperclip(-[^\\/]+)?[\\/]'

function Add-Pid([System.Collections.Generic.HashSet[int]]$set, [int]$processId) {
  if ($processId -lt 8) { return }
  [void]$set.Add($processId)
}

$pids = [System.Collections.Generic.HashSet[int]]::new()

Write-Host "Repo: $RepoRoot"

# 1) Registered Paperclip dev processes (same as pnpm dev:stop)
if (-not $DryRun) {
  Push-Location $RepoRoot
  try {
    pnpm dev:stop
  }
  catch {
    Write-Host "pnpm dev:stop: $_"
  }
  finally {
    Pop-Location
  }
}
else {
  Write-Host "[dry-run] would run: pnpm dev:stop"
}

# 2) Listeners on common Paperclip / Vite ports
$ports = 3100, 3101, 3102, 3103, 3104, 3105, 3106, 3107, 3108, 3109, 3110, 5173, 5174
foreach ($port in $ports) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 }
  foreach ($c in $conns) {
    Add-Pid $pids $c.OwningProcess
  }
}

# 3) node.exe whose cwd path looks like this monorepo / any paperclip worktree
$nodes = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $PaperclipPathRegex }
foreach ($n in $nodes) {
  Add-Pid $pids $n.ProcessId
}

# 4) Codebuddy CLI (separate from Paperclip path match)
if (-not $KeepCodebuddy) {
  $buddy = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and (
        $_.CommandLine -match '@tencent-ai[\\/]codebuddy-code' -or
        $_.CommandLine -match 'codebuddy-code[\\/]bin[\\/]codebuddy'
      )
    }
  foreach ($b in $buddy) {
    Add-Pid $pids $b.ProcessId
  }
}

# 5) Embedded PostgreSQL from node_modules (orphan postmaster)
$pg = Get-CimInstance Win32_Process -Filter "name = 'postgres.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match '(?i)embedded-postgres' -and
    $_.CommandLine -like "*${RepoLeaf}*"
  }
foreach ($p in $pg) {
  Add-Pid $pids $p.ProcessId
}

# 6) Git-bash shells stuck on vitest in this repo (optional leak pattern)
$bashVitest = Get-CimInstance Win32_Process -Filter "name = 'bash.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like "*${RepoLeaf}*" -and
    $_.CommandLine -match '(?i)vitest'
  }
foreach ($b in $bashVitest) {
  Add-Pid $pids $b.ProcessId
}

$sorted = @($pids | Sort-Object -Unique)
if ($sorted.Count -eq 0) {
  Write-Host "No extra processes matched (ports + path heuristics). Done."
  exit 0
}

Write-Host ""
Write-Host "Candidates (PID): $($sorted -join ', ')"

foreach ($processId in $sorted) {
  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  $line = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty CommandLine -ErrorAction SilentlyContinue
  $snippet = if ($line.Length -gt 160) { $line.Substring(0, 157) + "..." } else { $line }
  Write-Host "  $processId  $($proc.ProcessName)  $snippet"
}

if ($DryRun) {
  Write-Host ""
  Write-Host "Dry run — re-run without -DryRun to Stop-Process."
  exit 0
}

Write-Host ""
Write-Host "Stopping..."
foreach ($processId in $sorted) {
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
    Write-Host "  stopped $processId"
  }
  catch {
    Write-Host "  skip $processId ($($_.Exception.Message))"
  }
}

Write-Host "Done."
