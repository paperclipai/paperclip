#!/usr/bin/env pwsh
#Requires -Version 5.1
<#
.SYNOPSIS
    Kill all Paperclip-related background processes (Windows + cross-platform).

.DESCRIPTION
    Detects and terminates:
    - Node processes running paperclip (dev-runner, tsx, vite, etc.)
    - Embedded PostgreSQL processes (@embedded-postgres)
    - Agent browser processes (headless Chrome)
    - Vitest processes

    Also cleans up stale data/pglite directories.

.PARAMETER DryRun
    Preview what would be killed without actually killing.

.PARAMETER CleanData
    Also remove data/pglite directories after killing postgres.

.EXAMPLE
    .\scripts\kill-paperclip.ps1
    .\scripts\kill-paperclip.ps1 -DryRun
    .\scripts\kill-paperclip.ps1 -CleanData
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$CleanData
)

$ErrorActionPreference = "Continue"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Get-ProcessCommandLine {
    param([int]$ProcessId)
    try {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
        return $proc.CommandLine
    } catch {
        return $null
    }
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    try {
        $null = Get-Process -Id $ProcessId -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Wait-ProcessExit {
    param([int]$ProcessId, [int]$TimeoutSec = 10)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        if (-not (Test-ProcessAlive $ProcessId)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return -not (Test-ProcessAlive $ProcessId)
}

# ---------------------------------------------------------------------------
# Detect processes
# ---------------------------------------------------------------------------

$nodeTargets = @()
$pgTargets   = @()
$browserTargets = @()
$vitestTargets  = @()

# Node processes related to paperclip
foreach ($proc in Get-Process -Name "node" -ErrorAction SilentlyContinue) {
    $cmd = Get-ProcessCommandLine -ProcessId $proc.Id
    if ($cmd -match "paperclip|dev-runner|tsx.*server|vite") {
        $nodeTargets += [PSCustomObject]@{
            Pid     = $proc.Id
            Command = $cmd
            Type    = "node"
        }
    }
}

# Embedded PostgreSQL
foreach ($proc in Get-Process -Name "postgres" -ErrorAction SilentlyContinue) {
    $cmd = Get-ProcessCommandLine -ProcessId $proc.Id
    if ($cmd -match "embedded-postgres|pglite") {
        $pgTargets += [PSCustomObject]@{
            Pid     = $proc.Id
            Command = $cmd
            Type    = "postgres"
        }
    }
}

# pg_ctl (PostgreSQL control)
foreach ($proc in Get-Process -Name "pg_ctl" -ErrorAction SilentlyContinue) {
    $cmd = Get-ProcessCommandLine -ProcessId $proc.Id
    if ($cmd -match "embedded-postgres|pglite") {
        $pgTargets += [PSCustomObject]@{
            Pid     = $proc.Id
            Command = $cmd
            Type    = "pg_ctl"
        }
    }
}

# Agent browsers
foreach ($proc in Get-Process -Name "chrome" -ErrorAction SilentlyContinue) {
    $cmd = Get-ProcessCommandLine -ProcessId $proc.Id
    if ($cmd -match "headless|agent-browser|Chrome for Testing") {
        $browserTargets += [PSCustomObject]@{
            Pid     = $proc.Id
            Command = $cmd
            Type    = "browser"
        }
    }
}

# Vitest
foreach ($proc in Get-Process -Name "node" -ErrorAction SilentlyContinue) {
    $cmd = Get-ProcessCommandLine -ProcessId $proc.Id
    if ($cmd -match "vitest") {
        $vitestTargets += [PSCustomObject]@{
            Pid     = $proc.Id
            Command = $cmd
            Type    = "vitest"
        }
    }
}

$allTargets = $nodeTargets + $pgTargets + $browserTargets + $vitestTargets

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

if ($allTargets.Count -eq 0) {
    Write-Host "No Paperclip-related processes found." -ForegroundColor Green
} else {
    Write-Host "Found $($allTargets.Count) Paperclip-related process(es):" -ForegroundColor Yellow
    Write-Host ""
    foreach ($t in $allTargets) {
        $shortCmd = $t.Command
        if ($shortCmd.Length -gt 80) { $shortCmd = $shortCmd.Substring(0, 77) + "..." }
        Write-Host "  [$($t.Type.PadRight(8))] PID $($t.Pid.ToString().PadRight(6))  $shortCmd" -ForegroundColor Cyan
    }
    Write-Host ""
}

if ($DryRun) {
    Write-Host "Dry run - no processes were killed." -ForegroundColor Magenta
    exit 0
}

# ---------------------------------------------------------------------------
# Kill
# ---------------------------------------------------------------------------

$killed = 0
$failed = 0

foreach ($t in $allTargets) {
    Write-Host "  Stopping $($t.Type) PID $($t.Pid)..." -NoNewline -ForegroundColor DarkGray
    try {
        Stop-Process -Id $t.Pid -Force -ErrorAction Stop
        $exited = Wait-ProcessExit -ProcessId $t.Pid -TimeoutSec 5
        if ($exited) {
            Write-Host " OK" -ForegroundColor Green
            $killed++
        } else {
            Write-Host " TIMEOUT (may be zombie)" -ForegroundColor Red
            $failed++
        }
    } catch {
        Write-Host " FAILED: $_" -ForegroundColor Red
        $failed++
    }
}

# ---------------------------------------------------------------------------
# Clean data directories
# ---------------------------------------------------------------------------

if ($CleanData) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $pglitePaths = @(
        "$repoRoot\data\pglite"
        "$repoRoot\.paperclip\instances"
    )
    foreach ($p in $pglitePaths) {
        if (Test-Path $p) {
            Write-Host "  Removing $p ..." -NoNewline -ForegroundColor DarkGray
            try {
                Remove-Item -Path $p -Recurse -Force -ErrorAction Stop
                Write-Host " OK" -ForegroundColor Green
            } catch {
                Write-Host " FAILED: $_" -ForegroundColor Red
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ""
if ($killed -gt 0) {
    Write-Host "Killed $killed process(es)." -ForegroundColor Green
}
if ($failed -gt 0) {
    Write-Host "$failed process(es) could not be stopped (may require manual intervention)." -ForegroundColor Red
}
if ($allTargets.Count -eq 0) {
    Write-Host "Nothing to do." -ForegroundColor Green
}
