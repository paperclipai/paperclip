#requires -Version 5.1
<#
  在**新的外置 PowerShell 窗口**（-NoExit）中启动本仓库开发服：可选先起 Compose Postgres，再受管 `pnpm dev`（dev-runner，单次 tsx + 空闲时受控重启，无 tsx file-watch）。

  重要：`pwsh -File scripts\...` 里的相对路径是相对**当前终端所在目录**，不是脚本所在目录。
  - 任选其一：
    A) 先进入仓库根再跑相对路径；
    B) 从任意目录用**脚本绝对路径**（推荐从资源管理器/快捷方式拷贝路径）。

  用法示例 — 先入仓库根（相对路径生效）：
    cd C:\path\to\paperclip-latest-20260512
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -NoCompose
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -DryRun
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SameWindow
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SkipPrereq
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -NoComposeWait
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SkipDatabaseUrlCheck

  用法示例 — 人在 `C:\Users\...\` 等任意目录（绝对路径）：
    pwsh -NoProfile -File "C:\path\to\paperclip-latest-20260512\scripts\start-paperclip-dev-external.ps1" -NoCompose

  只看到父终端一行提示、没找到服务：**任务栏 Alt+Tab 找新建的 pwsh 窗口**，或直接用本机当前终端前台跑：
    pwsh -NoProfile -File .\scripts\start-paperclip-dev-external.ps1 -SameWindow

  收尾：在外置窗口里 Ctrl+C（`-SameWindow` 则在本终端 Ctrl+C），再在仓库根执行 `pnpm dev:stop` / `pnpm dev:nuke`（见 docs/项目计划/最佳实践/001-运维-回形针本地.md）。

  起服顺序：**监听口预检** → **Compose 预检**（读根目录 `.env` 校验 `DATABASE_URL` 是否对得上本 Compose 映射；`db` 已在跑且健康则**不再** `docker compose up`；否则 `up -d --wait`；compose 失败**直接退出**）→ **`pnpm dev`**。就绪仍以日志横幅与 **`/api/health`** 为准。
  外置窗用 **`pwsh -NoExit -File scripts/run-paperclip-dev-session.ps1`** 拉起，避免 **`-Command` 塞多行脚本**在 Windows 上断句、窗口只闪光标。
  1) `scripts/ensure-paperclip-ports-free.ps1`（占用则失败，与 `PAPERCLIP_STRICT_PORTS` 对齐）
  2) `scripts/paperclip-dev-compose-preflight.ps1`（容器已健康则不再 `docker compose up`；校验 DATABASE_URL；失败则退出）
  3) `pnpm dev`，见 `scripts/run-paperclip-dev-session.ps1`
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
    Write-Host "SameWindow: running docker + pnpm here (blocking). Ctrl+C to stop." -ForegroundColor Green
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
