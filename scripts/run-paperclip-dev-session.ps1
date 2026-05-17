#requires -Version 5.1
<#
  由 start-paperclip-dev-external.ps1 用 -File 拉起（勿手填参数）。
  依赖进程环境：PAPERCLIP_REPO_ROOT、PAPERCLIP_START_WITH_COMPOSE、PAPERCLIP_COMPOSE_FILE、
  PAPERCLIP_CHILD_SAME_WINDOW、PAPERCLIP_SKIP_DEV_PREREQ、PAPERCLIP_COMPOSE_WAIT、PAPERCLIP_SKIP_DB_URL_CHECK。
  末尾执行 pnpm dev:once（dev-runner 子进程一次拉起；不安装变更扫描 / 空闲自动重启）。等价于向 dev-runner 传参 once，或设 PAPERCLIP_DEV_RUNNER_ONCE=1。
#>
$ErrorActionPreference = "Continue"
if (-not $env:PAPERCLIP_REPO_ROOT) { throw "PAPERCLIP_REPO_ROOT is not set" }
Set-Location -LiteralPath $env:PAPERCLIP_REPO_ROOT
Write-Host ""
$m = if ($env:PAPERCLIP_CHILD_SAME_WINDOW -eq "1") { "this terminal (SameWindow)" } else { "external pwsh window" }
Write-Host "Paperclip dev ($m)" -ForegroundColor Cyan
Write-Host "Repo: $(Get-Location)" -ForegroundColor Gray
Write-Host ""

if ($env:PAPERCLIP_SKIP_DEV_PREREQ -ne "1") {
  $preScript = Join-Path $env:PAPERCLIP_REPO_ROOT "scripts\ensure-paperclip-ports-free.ps1"
  & $preScript
  # 成功时 PS 7.6 可能未设 $LASTEXITCODE，读取它会抛错；失败由子脚本的 exit 终止进程
}

if ($env:PAPERCLIP_START_WITH_COMPOSE -eq "1") {
  $cf = $env:PAPERCLIP_COMPOSE_FILE
  if (-not $cf) { $cf = "docker/docker-compose.yml" }
  $preCompose = Join-Path $env:PAPERCLIP_REPO_ROOT "scripts\paperclip-dev-compose-preflight.ps1"
  $skipDbUrl = ($env:PAPERCLIP_SKIP_DB_URL_CHECK -eq "1")
  $noWait = ($env:PAPERCLIP_COMPOSE_WAIT -ne "1")
  & $preCompose -RepoRoot $env:PAPERCLIP_REPO_ROOT -ComposeFileRel $cf -NoWait:$noWait -SkipDatabaseUrlCheck:$skipDbUrl
}

Write-Host "pnpm dev:once (no dev-runner change scan / idle auto-restart)" -ForegroundColor DarkGray
& pnpm dev:once
