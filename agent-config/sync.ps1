<#
.SYNOPSIS
  Sync agent instruction files from this fork into live Paperclip agent dirs.

.DESCRIPTION
  Paperclip's `instructionsBundleMode: "managed"` reads instructions from a
  local directory under each company/agent. There is no native git-backed
  source. This script bridges the gap:

    agent-config/companies/{companyId}/agents/{agentId}/instructions/*.md
        --copies-into-->
    {paperclipRoot}/companies/{companyId}/agents/{agentId}/instructions/

  Run from the root of the fork checkout. Files in `--target` that are NOT
  present in agent-config are left alone (no destructive delete) unless
  `-Mirror` is passed.

.PARAMETER PaperclipRoot
  Path to the Paperclip instance root containing `companies/`. Defaults to
  $env:PAPERCLIP_INSTANCE_ROOT, then $HOME/.paperclip/instances/default.

.PARAMETER DryRun
  Show what would change without writing.

.PARAMETER Mirror
  Delete files in target that are absent from agent-config. Off by default.

.PARAMETER Pull
  Run `git pull --ff-only` first so you sync the latest fork state.

.EXAMPLE
  pwsh ./agent-config/sync.ps1 -Pull
  pwsh ./agent-config/sync.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$PaperclipRoot,
  [switch]$DryRun,
  [switch]$Mirror,
  [switch]$Pull
)

$ErrorActionPreference = "Stop"

$scriptRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$forkRoot     = Split-Path -Parent $scriptRoot
$configRoot   = Join-Path $scriptRoot "companies"
$manifestPath = Join-Path $scriptRoot "manifest.json"

if (-not $PaperclipRoot -or $PaperclipRoot -eq "") {
  if ($env:PAPERCLIP_INSTANCE_ROOT) {
    $PaperclipRoot = $env:PAPERCLIP_INSTANCE_ROOT
  } else {
    $PaperclipRoot = Join-Path $HOME ".paperclip\instances\default"
  }
}

if (-not (Test-Path $configRoot)) {
  throw "Config root not found: $configRoot"
}
if (-not (Test-Path $manifestPath)) {
  throw "Manifest not found: $manifestPath"
}
if (-not (Test-Path $PaperclipRoot)) {
  throw "Paperclip root not found: $PaperclipRoot (set -PaperclipRoot or `$env:PAPERCLIP_INSTANCE_ROOT)"
}

if ($Pull) {
  Write-Host "==> git pull --ff-only origin master"
  & git -C $forkRoot pull --ff-only origin master
  if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$summary = [System.Collections.ArrayList]@()

foreach ($company in $manifest.companies) {
  $companyId = $company.id
  Write-Host "==> Company: $($company.name) [$companyId]"

  foreach ($agent in $company.agents) {
    $agentId  = $agent.id
    $srcDir   = Join-Path $configRoot "$companyId\agents\$agentId\instructions"
    $dstDir   = Join-Path $PaperclipRoot "companies\$companyId\agents\$agentId\instructions"

    if (-not (Test-Path $srcDir)) {
      Write-Warning "  - $($agent.name): source missing ($srcDir); skipping"
      continue
    }

    if (-not (Test-Path $dstDir)) {
      if ($DryRun) {
        Write-Host "  + CREATE $dstDir"
      } else {
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
      }
    }

    $copied = 0; $updated = 0; $unchanged = 0; $removed = 0
    $srcFiles = Get-ChildItem $srcDir -File -Filter "*.md"

    foreach ($f in $srcFiles) {
      $dstPath = Join-Path $dstDir $f.Name
      $needsCopy = $true
      if (Test-Path $dstPath) {
        $srcHash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
        $dstHash = (Get-FileHash $dstPath   -Algorithm SHA256).Hash
        if ($srcHash -eq $dstHash) { $needsCopy = $false; $unchanged++ }
      }
      if ($needsCopy) {
        if (Test-Path $dstPath) { $updated++ } else { $copied++ }
        if ($DryRun) {
          Write-Host "    ~ $($f.Name)"
        } else {
          Copy-Item $f.FullName -Destination $dstPath -Force
        }
      }
    }

    if ($Mirror) {
      $srcNames = $srcFiles | ForEach-Object { $_.Name }
      Get-ChildItem $dstDir -File -Filter "*.md" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -notin $srcNames) {
          $removed++
          if ($DryRun) {
            Write-Host "    - DELETE $($_.Name)"
          } else {
            Remove-Item $_.FullName -Force
          }
        }
      }
    }

    [void]$summary.Add([pscustomobject]@{
      Agent = $agent.name
      Id = $agentId
      New = $copied
      Updated = $updated
      Unchanged = $unchanged
      Removed = $removed
    })
  }
}

Write-Host ""
Write-Host "==> Summary$(if ($DryRun) { ' (dry run)' })"
$summary | Format-Table -AutoSize | Out-String | Write-Host
