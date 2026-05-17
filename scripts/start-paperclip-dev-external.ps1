#requires -Version 5.1
<#
  本地起 Paperclip 的**唯一推荐入口**：本脚本（一条龙）。
  在新外置 PowerShell 窗口（-NoExit）中：端口预检 → 可选 Compose Postgres 预检 → **`pnpm dev:once`**
  （`dev-runner.ts` 子进程 + **不**安装源码变更轮询 / 空闲自动重启；无 tsx file-watch）。

  相对路径提示：`pwsh -File scripts\...` 的相对路径是相对于**当前目录**；不在仓库根时改用脚本**绝对路径**。

  示例：
    cd C:\path\to\paperclip-latest-20260512
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -NoCompose
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -DryRun
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SameWindow
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SkipPrereq
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -NoComposeWait
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SkipDatabaseUrlCheck
    pwsh -NoProfile -File "C:\path\to\paperclip-latest-20260512\scripts\start-paperclip-dev-external.ps1" -NoCompose

  若只在本终端看到一行 "Started external..."：**任务栏 Alt+Tab** 找新 pwsh，或加 **-SameWindow** 在同一窗口阻塞输出。

  收尾：运行 dev 的窗口里 Ctrl+C，再在仓库根 `pnpm dev:stop` / `pnpm dev:nuke`（见 docs/项目计划/最佳实践/001-运维-回形针本地.md）。

  顺序：**监听口预检** → **Compose 预检**（`.env` 校验 `DATABASE_URL`；`db` 已健康则不再 `up`；否则 `up -d --wait`）→ **`pnpm dev:once`**。就绪以日志横幅与 `/api/health` 为准。

  外置窗用 `pwsh -NoExit -File scripts/run-paperclip-dev-session.ps1` 拉起。
  1) scripts/ensure-paperclip-ports-free.ps1
  2) scripts/paperclip-dev-compose-preflight.ps1
  3) pnpm dev:once（见 run-paperclip-dev-session.ps1）
#>
param(
  [switch]$NoCompose,
  [switch]$DryRun,
  [switch]$SameWindow,
  [switch]$SkipPrereq,
  [switch]$NoComposeWait,
  [switch]$SkipDatabaseUrlCheck,
  [string]$ComposeFile = "docker/docker-compose.yml"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sessionScript = Join-Path $PSScriptRoot "run-paperclip-dev-session.ps1"
if (-not (Test-Path -LiteralPath $sessionScript)) {
  throw "Missing launcher script: $sessionScript"
}

$shell = "pwsh.exe"
if (-not (Get-Command $shell -ErrorAction SilentlyContinue)) {
  $shell = "powershell.exe"
}

if ($DryRun) {
  Write-Host "[DryRun] RepoRoot: $RepoRoot"
  Write-Host "[DryRun] Shell: $shell"
  Write-Host "[DryRun] SessionScript: $sessionScript"
  Write-Host "[DryRun] NoCompose: $NoCompose  SameWindow: $SameWindow  SkipPrereq: $SkipPrereq  NoComposeWait: $NoComposeWait  SkipDatabaseUrlCheck: $SkipDatabaseUrlCheck  ComposeFile: $ComposeFile"
  exit 0
}

$env:PAPERCLIP_REPO_ROOT = $RepoRoot
$env:PAPERCLIP_START_WITH_COMPOSE = if ($NoCompose) { "0" } else { "1" }
$env:PAPERCLIP_COMPOSE_FILE = $ComposeFile
$env:PAPERCLIP_CHILD_SAME_WINDOW = if ($SameWindow) { "1" } else { "0" }
$env:PAPERCLIP_SKIP_DEV_PREREQ = if ($SkipPrereq) { "1" } else { "0" }
$env:PAPERCLIP_COMPOSE_WAIT = if ($NoCompose -or $NoComposeWait) { "0" } else { "1" }
$env:PAPERCLIP_SKIP_DB_URL_CHECK = if ($SkipDatabaseUrlCheck) { "1" } else { "0" }

try {
  if ($SameWindow) {
    Write-Host "SameWindow: running docker + pnpm dev:once here (blocking). Ctrl+C to stop." -ForegroundColor Green
    & $sessionScript
  }
  else {
    Start-Process -FilePath $shell -WorkingDirectory $RepoRoot -WindowStyle Normal -ArgumentList @(
      "-NoProfile",
      "-NoExit",
      "-File",
      $sessionScript
    ) | Out-Null

    Write-Host "Started external window ($shell). Watch that window for the listen banner; Ctrl+C there to stop." -ForegroundColor Green
    Write-Host "If you only see this line: Alt+Tab / taskbar for another pwsh, or rerun with -SameWindow to stream logs in this terminal." -ForegroundColor Yellow
  }
}
finally {
  Remove-Item Env:PAPERCLIP_REPO_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_START_WITH_COMPOSE -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_COMPOSE_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_CHILD_SAME_WINDOW -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_SKIP_DEV_PREREQ -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_COMPOSE_WAIT -ErrorAction SilentlyContinue
  Remove-Item Env:PAPERCLIP_SKIP_DB_URL_CHECK -ErrorAction SilentlyContinue
}
