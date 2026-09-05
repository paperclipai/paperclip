param(
  [string]$PaperclipRepo = "C:\Users\admin\Documents\Paperclip",
  [string]$PluginRoot = "C:\Users\admin\.paperclip\plugins\node_modules\paperclip-plugin-telegram",
  [switch]$Deep
)

$ErrorActionPreference = "Stop"

function Require-Marker([string]$Path, [string]$Pattern, [string]$Name) {
  if (-not (Select-String -Path $Path -Pattern $Pattern -Quiet)) {
    throw "VERIFY_MISSING: $Name"
  }
}

$constantsPath = Join-Path $PaperclipRepo "packages\shared\src\constants.ts"
$activityPath = Join-Path $PaperclipRepo "server\src\services\activity-log.ts"
$manifestPath = Join-Path $PluginRoot "dist\manifest.js"
$workerPath = Join-Path $PluginRoot "dist\worker.js"
$packagePath = Join-Path $PluginRoot "package.json"

foreach ($path in @($constantsPath, $activityPath, $manifestPath, $workerPath, $packagePath)) {
  if (-not (Test-Path $path)) { throw "VERIFY_FILE_NOT_FOUND: $path" }
}

$pkg = Get-Content $packagePath -Raw | ConvertFrom-Json
if ($pkg.name -ne "paperclip-plugin-telegram" -or $pkg.version -ne "0.8.0") {
  throw "VERIFY_PIN_MISMATCH: expected paperclip-plugin-telegram@0.8.0"
}

Require-Marker $constantsPath '"issue\.thread_interaction\.created"' "Paperclip plugin event type"
Require-Marker $activityPath 'issue_thread_interaction_created:\s*"issue\.thread_interaction\.created"' "Paperclip activity mapping"
Require-Marker $manifestPath '"issue\.interactions\.read"' "Telegram read capability"
Require-Marker $manifestPath '"issue\.interactions\.respond"' "Telegram respond capability"
Require-Marker $workerPath 'issue\.thread_interaction\.created' "Telegram decision event handler"
Require-Marker $workerPath 'decision_accept_' "Telegram approve callback"
Require-Marker $workerPath 'decision_revise_' "Telegram revise callback"
Require-Marker $workerPath 'listInteractions' "Telegram pending-state recheck"
Require-Marker $workerPath 'respondInteraction' "Telegram governed interaction response"

node --check $manifestPath
node --check $workerPath

Set-Location $PaperclipRepo
git diff --check -- packages/shared/src/constants.ts server/src/services/activity-log.ts

if ($Deep) {
  pnpm --filter @paperclipai/shared typecheck
  pnpm --filter @paperclipai/server typecheck
}

Write-Host "TELEGRAM_OWNER_DECISION_VERIFY=PASS"
