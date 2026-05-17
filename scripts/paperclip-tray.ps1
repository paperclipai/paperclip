#requires -Version 5.1
<#
  Paperclip 本机开发：系统托盘 — 打开看板 / 重启一条龙 / 退出并 dev:stop

  WinForms 需要 STA，若当前不是 STA 会自拉起。请优先用：
    pwsh -NoProfile -STA -File scripts\paperclip-tray.ps1

  仓库根目录由脚本路径推导（scripts 的上级）；也可显式指定 -RepoRoot。
#>
param(
  [string]$RepoRoot = "",
  [string]$BoardUrl = "http://127.0.0.1:3100/",
  [switch]$NoCompose
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-PaperclipRepoRoot {
  if ($RepoRoot -and (Test-Path -LiteralPath $RepoRoot)) {
    return (Resolve-Path -LiteralPath $RepoRoot).Path
  }
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Invoke-PnpmDevStop {
  param([string]$Root)
  Push-Location $Root
  try {
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = "pnpm"
    $pinfo.Arguments = "dev:stop"
    $pinfo.WorkingDirectory = $Root
    $pinfo.UseShellExecute = $false
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.CreateNoWindow = $true
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $pinfo
    [void]$p.Start()
    $null = $p.StandardOutput.ReadToEnd()
    $null = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
  }
  catch {
    # pnpm 未在 PATH 或进程失败时仅记录；退出路径仍会关掉托盘
    Write-Warning "pnpm dev:stop: $($_.Exception.Message)"
  }
  finally {
    Pop-Location
  }
}

function Start-PaperclipExternalWindow {
  param([string]$Root)
  $startScript = Join-Path $PSScriptRoot "start-paperclip-dev-external.ps1"
  if (-not (Test-Path -LiteralPath $startScript)) {
    throw "Missing: $startScript"
  }
  Push-Location $Root
  try {
    if ($NoCompose) {
      & $startScript -NoCompose
    }
    else {
      & $startScript
    }
  }
  finally {
    Pop-Location
  }
}

# STA：NotifyIcon 需要单线程套间
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
  $shell = Get-Command pwsh -ErrorAction SilentlyContinue
  if (-not $shell) {
    $shell = Get-Command powershell -ErrorAction SilentlyContinue
  }
  if (-not $shell) {
    throw "需要 pwsh 或 Windows PowerShell。"
  }
  $exe = $shell.Source
  $self = $MyInvocation.MyCommand.Path
  $pass = @("-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", $self)
  if ($RepoRoot) { $pass += "-RepoRoot", $RepoRoot }
  if ($BoardUrl -ne "http://127.0.0.1:3100/") { $pass += "-BoardUrl", $BoardUrl }
  if ($NoCompose) { $pass += "-NoCompose" }
  Start-Process -FilePath $exe -ArgumentList $pass -WorkingDirectory (Get-PaperclipRepoRoot)
  exit 0
}

$root = Get-PaperclipRepoRoot

# 单实例（按仓库路径哈希，避免路径过长）
$hash = [BitConverter]::ToString(
  [System.Security.Cryptography.SHA1]::Create().ComputeHash(
    [Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())
  )
) -replace '-', ''
$mutexName = "Local\PaperclipDevTray_$hash"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$hasHandle = $false
try {
  $hasHandle = $mutex.WaitOne(0, $false)
}
catch {
  $hasHandle = $true
}
if (-not $hasHandle) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "该仓库的 Paperclip 托盘已在运行。",
    "Paperclip",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  ) | Out-Null
  exit 0
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "未在 PATH 中找到 pnpm。请先安装 pnpm 或将其加入 PATH。",
    "Paperclip",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
  if ($mutex) { $mutex.ReleaseMutex() | Out-Null; $mutex.Dispose() }
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.Visible = $false
$form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true
$notifyIcon.Text = "Paperclip Dev (Tray)"

$ctx = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $ctx.Items.Add("打开看板")
$miRestart = $ctx.Items.Add("重启一条龙")
$miSep = $ctx.Items.Add("-")
$miExit = $ctx.Items.Add("退出（并停止 dev）")

$miOpen.add_Click({
  try {
    Start-Process $BoardUrl
  }
  catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Paperclip") | Out-Null
  }
})

$miRestart.add_Click({
  try {
    Invoke-PnpmDevStop -Root $root
    Start-PaperclipExternalWindow -Root $root
  }
  catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "重启失败", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
  }
})

$miExit.add_Click({
  try {
    Invoke-PnpmDevStop -Root $root
  }
  finally {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    $form.Close()
  }
})

$notifyIcon.ContextMenuStrip = $ctx
$notifyIcon.add_MouseClick({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    try { Start-Process $BoardUrl } catch { }
  }
})

$form.add_FormClosing({
  if ($notifyIcon) {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
  }
  if ($mutex) {
    try { $mutex.ReleaseMutex() | Out-Null } catch { }
    $mutex.Dispose()
  }
})

$null = [System.Windows.Forms.Application]::Run($form)
