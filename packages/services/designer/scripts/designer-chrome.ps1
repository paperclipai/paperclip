# Launch a Chrome instance with remote debugging enabled, in a dedicated
# user-data-dir so the default profile's debug-port lockdown (Chrome 136+)
# doesn't block us. Sign in to Claude once inside the launched window;
# the profile persists.
#
# PowerShell equivalent of scripts/designer-chrome.sh for Windows users.

$ErrorActionPreference = 'Stop'

$Port    = if ($env:DESIGNER_CDP) { $env:DESIGNER_CDP } else { '9222' }
$Profile = Join-Path $env:USERPROFILE '.chrome-designer-profile'

# Default Chrome locations on Windows. Override with $env:CHROME_BIN.
$DefaultChromes = @(
  (Join-Path ${env:ProgramFiles}        'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)}   'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA          'Google\Chrome\Application\chrome.exe')
)
$Chrome = if ($env:CHROME_BIN) { $env:CHROME_BIN } else { $DefaultChromes | Where-Object { Test-Path $_ } | Select-Object -First 1 }

if (-not $Chrome -or -not (Test-Path $Chrome)) {
  Write-Error "[designer-chrome] Chrome not found. Set `$env:CHROME_BIN to override."
  exit 1
}

# CDP already listening?
try {
  $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
  Write-Host "[designer-chrome] CDP already listening on port $Port - nothing to do."
  Write-Host "                  curl http://127.0.0.1:$Port/json/version"
  exit 0
} catch {
  # not running - continue
}

# Warn if a non-debug Chrome is up
if (Get-Process -Name chrome -ErrorAction SilentlyContinue) {
  Write-Warning "[designer-chrome] Chrome is already running."
  Write-Warning "                  If it's NOT a debug-mode Chrome, the launched window may not get the debug port."
  Write-Warning "                  Close existing Chrome windows first, or accept the risk and continue."
}

Write-Host "[designer-chrome] Launching: $Chrome --remote-debugging-port=$Port --user-data-dir=$Profile"
Write-Host "[designer-chrome] Sign in to claude.ai in the new window. Then navigate to https://claude.ai/design."
Write-Host "[designer-chrome] When done, leave this window open. The CDP server runs as long as Chrome runs."

& $Chrome `
  "--remote-debugging-port=$Port" `
  "--user-data-dir=$Profile" `
  "https://claude.ai/design"
