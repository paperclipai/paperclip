param(
  [string]$PaperclipRepo = "C:\Users\admin\Documents\Paperclip",
  [string]$PluginRoot = "C:\Users\admin\.paperclip\plugins\node_modules\paperclip-plugin-telegram",
  [string]$PaperclipApi = "http://127.0.0.1:3100",
  [switch]$Deep
)

$ErrorActionPreference = "Stop"

function Require-Marker([string]$Path, [string]$Pattern, [string]$Name) {
  if (-not (Select-String -Path $Path -Pattern $Pattern -Quiet)) {
    throw "VERIFY_MISSING: $Name"
  }
}

function Forbid-Marker([string]$Path, [string]$Pattern, [string]$Name) {
  if (Select-String -Path $Path -Pattern $Pattern -Quiet) {
    throw "VERIFY_FORBIDDEN: $Name"
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
Require-Marker $workerPath 'resolveOwnerDecisionActorUserId' "Telegram canonical actor resolver"
Require-Marker $workerPath '/api/cli-auth/me' "Telegram cli-auth me introspection"
Require-Marker $workerPath 'Connect board access in Paperclip Telegram settings' "Telegram fail-closed board access message"

# identity must remain display-only in the decision callback path
Forbid-Marker $workerPath 'actorUserId\s*=\s*\([^\)]*boardAccess\.identity' "identity-as-actorUserId assignment"
Forbid-Marker $workerPath '\? boardAccess\.identity\s*:\s*null' "identity ternary used as actorUserId"

node --check $manifestPath
node --check $workerPath

Set-Location $PaperclipRepo
git diff --check -- packages/shared/src/constants.ts server/src/services/activity-log.ts

try {
  $health = Invoke-WebRequest -Uri "$($PaperclipApi.TrimEnd('/'))/api/health" -UseBasicParsing -TimeoutSec 15
  if ($health.StatusCode -ne 200) { throw "HEALTH_NOT_200: $($health.StatusCode)" }
  Write-Host "HEALTH=200"

  $plugins = Invoke-RestMethod -Uri "$($PaperclipApi.TrimEnd('/'))/api/plugins" -Method Get -TimeoutSec 15
  $telegram = @($plugins) | Where-Object {
    $_.pluginKey -eq "paperclip-plugin-telegram" -or $_.packageName -eq "paperclip-plugin-telegram"
  } | Select-Object -First 1
  if (-not $telegram) {
    Write-Host "TELEGRAM_PLUGIN_STATUS=MISSING"
  } else {
    Write-Host "TELEGRAM_PLUGIN_STATUS=$($telegram.status)"
    if ($telegram.status -ne "ready") {
      throw "TELEGRAM_PLUGIN_NOT_READY: $($telegram.status)"
    }
  }
} catch {
  if ($Deep) { throw }
  Write-Host "LIVE_CHECKS=SKIPPED ($($_.Exception.Message))"
}

if ($Deep) {
  pnpm --filter @paperclipai/shared typecheck
  pnpm --filter @paperclipai/server typecheck
}

Write-Host "TELEGRAM_OWNER_DECISION_VERIFY=PASS"
