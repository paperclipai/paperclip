param(
  [string]$InstallDir = (Join-Path $HOME "paperclip"),
  [switch]$NoStart,
  [switch]$ForceInstall,
  [switch]$SkipUpdate
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/lkrkavin/paperclip.git"
$Branch = "feat/native-freellmapi-provider"

function Info($Message) { Write-Host "[Paperclip FastInstall] $Message" -ForegroundColor Cyan }
function StopWith($Message) { throw "[Paperclip FastInstall] $Message" }

# Verify prerequisites before downloading the repository.
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  StopWith "Git is required. Install Git for Windows, reopen PowerShell, and run this script again."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  StopWith "Node.js 24.11.0 or newer is required. Install the current Node.js 24 LTS release first."
}
$NodeVersion = (node -p "process.versions.node").Trim()
try { $ParsedNodeVersion = [version]$NodeVersion } catch { StopWith "Could not parse Node.js version: $NodeVersion" }
if ($ParsedNodeVersion -lt [version]"24.11.0") {
  StopWith "Node.js 24.11.0 or newer is required. Detected $NodeVersion."
}
if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  StopWith "Corepack was not found. Install a Node.js distribution that includes Corepack, or install pnpm 9.15.4."
}

Info "Using Node.js $NodeVersion"
Info "Using pnpm 9.15.4 through Corepack without installing global shims."

$Parent = Split-Path -Parent $InstallDir
if ($Parent -and -not (Test-Path $Parent)) {
  New-Item -ItemType Directory -Path $Parent -Force | Out-Null
}

if (Test-Path (Join-Path $InstallDir ".git")) {
  Info "Found an existing checkout at $InstallDir"
  Push-Location $InstallDir
  try {
    $Remote = (git remote get-url origin).Trim()
    if ($Remote -ne $RepoUrl -and $Remote -ne "https://github.com/lkrkavin/paperclip") {
      StopWith "The existing folder has a different Git origin ($Remote). Choose another -InstallDir to avoid changing it."
    }
    if (-not $SkipUpdate) {
      $Changes = git status --porcelain
      if ($Changes) {
        StopWith "Your checkout has local changes. Commit or back them up before updating, or use a different -InstallDir."
      }
      Info "Updating branch $Branch..."
      git fetch origin $Branch
      if ($LASTEXITCODE -ne 0) { StopWith "Git fetch failed." }
      git checkout $Branch
      if ($LASTEXITCODE -ne 0) { StopWith "Could not switch to $Branch." }
      git pull --ff-only origin $Branch
      if ($LASTEXITCODE -ne 0) { StopWith "Git update failed; your existing files were not reset." }
    }
  } finally {
    Pop-Location
  }
} elseif (Test-Path $InstallDir) {
  StopWith "Install path exists but is not a Git checkout: $InstallDir. Choose another -InstallDir."
} else {
  Info "Cloning our customised branch..."
  git clone --single-branch --branch $Branch $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { StopWith "Git clone failed." }
}

Push-Location $InstallDir
try {
  $ModulesPath = Join-Path $InstallDir "node_modules"
  $LockPath = Join-Path $InstallDir "pnpm-lock.yaml"
  $FingerprintPath = Join-Path $InstallDir ".paperclip-fastinstall-fingerprint"
  $Fingerprint = (Get-FileHash (Join-Path $InstallDir "package.json") -Algorithm SHA256).Hash +
    (Get-FileHash $LockPath -Algorithm SHA256).Hash +
    (Get-FileHash (Join-Path $InstallDir "pnpm-workspace.yaml") -Algorithm SHA256).Hash
  $PreviousFingerprint = if (Test-Path $FingerprintPath) { (Get-Content $FingerprintPath -Raw).Trim() } else { "" }

  if ($ForceInstall -or -not (Test-Path $ModulesPath) -or $Fingerprint -ne $PreviousFingerprint) {
    Info "Installing dependencies (pnpm cache will be reused on later runs)..."
    corepack pnpm@9.15.4 install --frozen-lockfile --prefer-offline
    if ($LASTEXITCODE -ne 0) { StopWith "Dependency installation failed. Fix the reported error and rerun this script." }
    Set-Content -Path $FingerprintPath -Value $Fingerprint -NoNewline
  } else {
    Info "Dependencies are already installed and manifests are unchanged; skipping reinstall."
  }

  if (-not $NoStart) {
    Info "Starting Paperclip development server..."
    Info "Open http://localhost:3100 when the server is ready. Press Ctrl+C to stop."
    corepack pnpm@9.15.4 dev
    if ($LASTEXITCODE -ne 0) { StopWith "Paperclip stopped with an error. Check the output above." }
  } else {
    Info "Installation is ready at $InstallDir"
    Info "Start it later with: cd `"$InstallDir`"; corepack pnpm@9.15.4 dev"
  }
} finally {
  Pop-Location
}
