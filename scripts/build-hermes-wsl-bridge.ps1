param(
  [string]$OutputPath = "scripts/hermes-wsl.exe"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repoRoot "scripts/hermes-wsl-bridge.cs"
$resolvedOutputPath = Join-Path $repoRoot $OutputPath
$outputDir = Split-Path -Parent $resolvedOutputPath

if (!(Test-Path $sourcePath)) {
  throw "Missing source file: $sourcePath"
}

if (!(Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

$cscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { $_ -and (Test-Path $_) }

if ($cscCandidates.Count -eq 0) {
  $command = Get-Command csc.exe -ErrorAction SilentlyContinue
  if ($command) {
    $cscCandidates = @($command.Source)
  }
}

if ($cscCandidates.Count -eq 0) {
  throw "Could not find csc.exe. Install .NET Framework build tools or run from a Developer PowerShell, then retry."
}

$csc = $cscCandidates[0]
& $csc /nologo /target:exe "/out:$resolvedOutputPath" $sourcePath

if ($LASTEXITCODE -ne 0) {
  throw "Failed to build Hermes WSL bridge."
}

Write-Host "Built Hermes WSL bridge:"
Write-Host $resolvedOutputPath
Write-Host ""
Write-Host "Optional runtime settings:"
Write-Host "  HERMES_WSL_DISTRO  WSL distro name, default: Ubuntu"
Write-Host "  HERMES_WSL_PATH    Hermes executable inside WSL, default: hermes"
