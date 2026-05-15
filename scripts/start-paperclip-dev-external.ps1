#requires -Version 5.1
<#
  在**新的外置 PowerShell 窗口**（-NoExit）中启动本仓库开发服：可选先起 Compose Postgres，再 `pnpm dev:once` 或 `pnpm dev`。

  重要：`pwsh -File scripts\...` 里的相对路径是相对**当前终端所在目录**，不是脚本所在目录。
  - 任选其一：
    A) 先进入仓库根再跑相对路径；
    B) 从任意目录用**脚本绝对路径**（推荐从资源管理器/快捷方式拷贝路径）。

  用法示例 — 先入仓库根（相对路径生效）：
    cd C:\path\to\paperclip-latest-20260512
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -NoCompose
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -Watch
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -DryRun
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SameWindow

  用法示例 — 人在 `C:\Users\...\` 等任意目录（绝对路径）：
    pwsh -NoProfile -File "C:\path\to\paperclip-latest-20260512\scripts\start-paperclip-dev-external.ps1" -NoCompose

  只看到父终端一行提示、没找到服务：**任务栏 Alt+Tab 找新建的 pwsh 窗口**，或直接用本机当前终端前台跑：
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SameWindow

  收尾：在外置窗口里 Ctrl+C（`-SameWindow` 则在本终端 Ctrl+C），再在仓库根执行 `pnpm dev:stop` / `pnpm dev:nuke`（见 docs/项目计划/最佳实践/运维-回形针本地.md）。
#>
param(
  [switch]$NoCompose,
  [switch]$Watch,
  [switch]$DryRun,
  [switch]$SameWindow,
  [string]$ComposeFile = "docker/docker-compose.yml"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$shell = "pwsh.exe"
if (-not (Get-Command $shell -ErrorAction SilentlyContinue)) {
  $shell = "powershell.exe"
}

$childBlock = @'
$ErrorActionPreference = "Continue"
if (-not $env:PAPERCLIP_REPO_ROOT) { throw "PAPERCLIP_REPO_ROOT is not set" }
Set-Location -LiteralPath $env:PAPERCLIP_REPO_ROOT
Write-Host ""
$m = if ($env:PAPERCLIP_CHILD_SAME_WINDOW -eq "1") { "this terminal (SameWindow)" } else { "external pwsh window" }
Write-Host "Paperclip dev ($m)" -ForegroundColor Cyan
Write-Host "Repo: $(Get-Location)" -ForegroundColor Gray
Write-Host ""

if ($env:PAPERCLIP_START_WITH_COMPOSE -eq "1") {
  $cf = $env:PAPERCLIP_COMPOSE_FILE
  if (-not $cf) { $cf = "docker/docker-compose.yml" }
  Write-Host "docker compose -f $cf up -d" -ForegroundColor DarkGray
  & docker compose -f $cf up -d
  if ($LASTEXITCODE -ne 0) {
    Write-Host ('docker compose exit code {0} - continuing anyway. If using Docker DB, verify Postgres.' -f $LASTEXITCODE) -ForegroundColor Yellow
  }
}

if ($env:PAPERCLIP_DEV_WATCH -eq "1") {
  Write-Host 'pnpm dev (watch mode)' -ForegroundColor DarkGray
  & pnpm dev
} else {
  Write-Host "pnpm dev:once" -ForegroundColor DarkGray
  & pnpm dev:once
}
'@

if ($DryRun) {
  Write-Host "[DryRun] RepoRoot: $RepoRoot"
  Write-Host "[DryRun] Shell: $shell"
  Write-Host "[DryRun] NoCompose: $NoCompose  Watch: $Watch  SameWindow: $SameWindow  ComposeFile: $ComposeFile"
  Write-Host "[DryRun] Child script body:"
  Write-Host $childBlock
  exit 0
}

$env:PAPERCLIP_REPO_ROOT = $RepoRoot
$env:PAPERCLIP_START_WITH_COMPOSE = if ($NoCompose) { "0" } else { "1" }
$env:PAPERCLIP_DEV_WATCH = if ($Watch) { "1" } else { "0" }
$env:PAPERCLIP_COMPOSE_FILE = $ComposeFile
$env:PAPERCLIP_CHILD_SAME_WINDOW = if ($SameWindow) { "1" } else { "0" }

try {
  if ($SameWindow) {
    Write-Host "SameWindow: running docker + pnpm here (blocking). Ctrl+C to stop." -ForegroundColor Green
    $sb = [scriptblock]::Create($childBlock)
    & $sb
  }
  else {
    Start-Process -FilePath $shell -WorkingDirectory $RepoRoot -WindowStyle Normal -ArgumentList @(
      "-NoProfile",
      "-NoExit",
      "-Command",
      $childBlock
    ) | Out-Null

    Write-Host "Started external window ($shell). Watch that window for the listen banner; Ctrl+C there to stop." -ForegroundColor Green
    Write-Host "If you only see this line: Alt+Tab / taskbar for another pwsh, or rerun with -SameWindow to stream logs in this terminal." -ForegroundColor Yellow
  }
}
finally {
  Remove-Item Env:PAPERCLIP_REPO_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_START_WITH_COMPOSE -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_DEV_WATCH -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_COMPOSE_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_CHILD_SAME_WINDOW -ErrorAction SilentlyContinue
}
