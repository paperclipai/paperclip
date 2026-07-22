#!/usr/bin/env bash
set -euo pipefail

MIN_NODE_MAJOR=20
DEFAULT_NODE_MAJOR=22
PAPERCLIP_PACKAGE="paperclipai"
HOMEBREW_INSTALL_COMMIT="99e13e96cbbdc1ac1ac09c0a40b450bf219ef3aa"
HOMEBREW_INSTALL_SHA256="99287f194a8b3c9e6b0203a11a5fa54518be57209343e6bb954dec4635796d9d"
NODESOURCE_DEB_SHA256="575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1"
NODESOURCE_RPM_SHA256="b0ed2b9b66002e7ee802e8777cf3a92b25f1ecc0129812dc6f59a43a536810cc"

CANARY=0
VERSION=""
REF=""
REPO=""
NO_ONBOARD=0
NO_PROMPT=0
INSTALL_SERVICE=0
DRY_RUN=0
VERBOSE=0
TEMP_DIR=""

usage() {
  cat <<'EOF'
Install Paperclip on macOS, Linux, or WSL2.

Usage:
  curl -fsSL https://paperclip.ing/install.sh | bash
  curl -fsSL https://paperclip.ing/install.sh | bash -s -- [options]

Options:
  --canary                 Install the canary channel
  --version <version>      Install an exact published version
  --ref <ref>              Install a GitHub branch, tag, or commit
  --repo <owner/repo>      Override the GitHub repository
  --no-onboard             Do not start onboarding after installation
  --no-prompt              Run non-interactively
  --install-service        Install the per-user Paperclip service
  --dry-run                Print the install plan without changing files
  --verbose                Enable verbose installer output
  -h, --help               Show this help

Every option also has a PAPERCLIP_INSTALL_* environment equivalent, for example
PAPERCLIP_INSTALL_REF=master and PAPERCLIP_INSTALL_NO_PROMPT=1.
EOF
}

log() {
  printf '[paperclip] %s\n' "$*"
}

fail() {
  printf '[paperclip] error: %s\n' "$*" >&2
  exit 1
}

parse_bool() {
  local name="$1"
  local value="${2:-}"

  case "${value,,}" in
    ""|0|false|no|off) printf '0' ;;
    1|true|yes|on) printf '1' ;;
    *) fail "$name must be one of: 1, 0, true, false, yes, no, on, off" ;;
  esac
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [ -n "$value" ] || fail "$option requires a value"
}

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT

CANARY="$(parse_bool PAPERCLIP_INSTALL_CANARY "${PAPERCLIP_INSTALL_CANARY:-}")"
VERSION="${PAPERCLIP_INSTALL_VERSION:-}"
REF="${PAPERCLIP_INSTALL_REF:-}"
REPO="${PAPERCLIP_INSTALL_REPO:-}"
NO_ONBOARD="$(parse_bool PAPERCLIP_INSTALL_NO_ONBOARD "${PAPERCLIP_INSTALL_NO_ONBOARD:-}")"
NO_PROMPT="$(parse_bool PAPERCLIP_INSTALL_NO_PROMPT "${PAPERCLIP_INSTALL_NO_PROMPT:-}")"
INSTALL_SERVICE="$(parse_bool PAPERCLIP_INSTALL_INSTALL_SERVICE "${PAPERCLIP_INSTALL_INSTALL_SERVICE:-}")"
DRY_RUN="$(parse_bool PAPERCLIP_INSTALL_DRY_RUN "${PAPERCLIP_INSTALL_DRY_RUN:-}")"
VERBOSE="$(parse_bool PAPERCLIP_INSTALL_VERBOSE "${PAPERCLIP_INSTALL_VERBOSE:-}")"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --canary)
      CANARY=1
      shift
      ;;
    --version)
      require_value "$1" "${2:-}"
      VERSION="$2"
      shift 2
      ;;
    --ref)
      require_value "$1" "${2:-}"
      REF="$2"
      shift 2
      ;;
    --repo)
      require_value "$1" "${2:-}"
      REPO="$2"
      shift 2
      ;;
    --no-onboard)
      NO_ONBOARD=1
      shift
      ;;
    --no-prompt)
      NO_PROMPT=1
      shift
      ;;
    --install-service)
      INSTALL_SERVICE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ "$#" -eq 0 ] || fail "unexpected argument: $1"

if [ "$CANARY" = "1" ] && [ -n "$VERSION" ]; then
  fail "--canary and --version cannot be used together"
fi

if [ -n "$REF" ] || [ -n "$REPO" ]; then
  fail "git-ref installs are not available in this installer build; omit --ref and --repo"
fi

if [ ! -t 0 ] || [ ! -t 1 ]; then
  NO_PROMPT=1
fi

if [ "$VERBOSE" = "1" ]; then
  set -x
fi

OS="$(uname -s 2>/dev/null || true)"
ARCH="$(uname -m 2>/dev/null || true)"

case "$OS" in
  Darwin) OS_NAME="macos" ;;
  Linux) OS_NAME="linux" ;;
  *) fail "unsupported operating system: ${OS:-unknown}. Use macOS, Linux, or WSL2." ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *) fail "unsupported architecture: ${ARCH:-unknown}. Supported architectures: x64, arm64." ;;
esac

log "Detected $OS_NAME/$ARCH_NAME"

node_major() {
  local version
  version="$(node --version 2>/dev/null || true)"
  version="${version#v}"
  printf '%s' "${version%%.*}"
}

has_supported_node() {
  local major
  command -v node >/dev/null 2>&1 || return 1
  major="$(node_major)"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [ "$major" -ge "$MIN_NODE_MAJOR" ] || return 1
  command -v npm >/dev/null 2>&1 || return 1
  command -v npx >/dev/null 2>&1 || return 1
}

print_command() {
  printf '[paperclip] +'
  printf ' %q' "$@"
  printf '\n'
}

confirm_command() {
  print_command "$@"
  if [ "$NO_PROMPT" = "1" ]; then
    return 0
  fi

  local answer
  printf '[paperclip] Run this command? [y/N] ' >/dev/tty
  IFS= read -r answer </dev/tty || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) ;;
    *) fail "installation cancelled" ;;
  esac
}

run_command() {
  confirm_command "$@"
  "$@"
}

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    run_command "$@"
    return
  fi

  command -v sudo >/dev/null 2>&1 || fail "sudo is required to install Node.js with the system package manager"
  run_command sudo "$@"
}

ensure_temp_dir() {
  if [ -z "$TEMP_DIR" ]; then
    TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-install.XXXXXX")"
  fi
}

download_checked_script() {
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"
  local actual_sha256

  command -v curl >/dev/null 2>&1 || fail "curl is required to bootstrap Node.js"
  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$destination"
  [ -s "$destination" ] || fail "downloaded script is empty: $url"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "$destination" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha256="$(shasum -a 256 "$destination" | awk '{print $1}')"
  else
    fail "sha256sum or shasum is required to verify downloaded scripts"
  fi
  [ "$actual_sha256" = "$expected_sha256" ] || fail "checksum mismatch for downloaded script: $url"
  [ "$(head -c 2 "$destination")" = '#!' ] || fail "downloaded file is not an executable script: $url"
  bash -n "$destination" || fail "downloaded script failed syntax validation: $url"
}

check_version_manager() {
  if [ -n "${NVM_DIR:-}" ] || [ -d "${HOME:-}/.nvm" ]; then
    fail "nvm was detected. Run 'nvm install ${DEFAULT_NODE_MAJOR}' and retry this installer."
  fi
  if command -v asdf >/dev/null 2>&1 || [ -d "${HOME:-}/.asdf" ]; then
    fail "asdf was detected. Run 'asdf install nodejs ${DEFAULT_NODE_MAJOR}' and retry this installer."
  fi
}

install_node_macos() {
  if ! command -v brew >/dev/null 2>&1; then
    ensure_temp_dir
    local brew_installer="$TEMP_DIR/homebrew-install.sh"
    log "Homebrew is required to install Node.js"
    download_checked_script "https://raw.githubusercontent.com/Homebrew/install/$HOMEBREW_INSTALL_COMMIT/install.sh" "$brew_installer" "$HOMEBREW_INSTALL_SHA256"
    if [ "$NO_PROMPT" = "1" ]; then
      run_command env NONINTERACTIVE=1 /bin/bash "$brew_installer"
    else
      run_command /bin/bash "$brew_installer"
    fi

    if [ -x /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew ]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi

  command -v brew >/dev/null 2>&1 || fail "Homebrew installation completed but 'brew' is not available on PATH"
  run_command brew install node
}

install_node_apt() {
  ensure_temp_dir
  local nodesource_installer="$TEMP_DIR/nodesource-setup.sh"
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  download_checked_script "https://deb.nodesource.com/setup_${DEFAULT_NODE_MAJOR}.x" "$nodesource_installer" "$NODESOURCE_DEB_SHA256"
  run_privileged env DEBIAN_FRONTEND=noninteractive bash "$nodesource_installer"
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
}

install_node_dnf() {
  ensure_temp_dir
  local nodesource_installer="$TEMP_DIR/nodesource-setup.sh"
  run_privileged dnf install -y ca-certificates curl
  download_checked_script "https://rpm.nodesource.com/setup_${DEFAULT_NODE_MAJOR}.x" "$nodesource_installer" "$NODESOURCE_RPM_SHA256"
  run_privileged bash "$nodesource_installer"
  run_privileged dnf install -y nodejs
}

install_node_linux() {
  if command -v apt-get >/dev/null 2>&1; then
    install_node_apt
  elif command -v dnf >/dev/null 2>&1; then
    install_node_dnf
  elif command -v pacman >/dev/null 2>&1; then
    run_privileged pacman -Sy --noconfirm --needed nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    run_privileged apk add --no-cache nodejs npm
  else
    fail "no supported Node.js package manager found. Supported: apt, dnf, pacman, apk."
  fi
}

if has_supported_node; then
  log "Using Node.js $(node --version)"
else
  if command -v node >/dev/null 2>&1; then
    log "Node.js $(node --version 2>/dev/null || printf unknown) is too old; Node.js >= $MIN_NODE_MAJOR is required"
  else
    log "Node.js was not found"
  fi
  check_version_manager
  log "Installing Node.js $DEFAULT_NODE_MAJOR"
  if [ "$OS_NAME" = "macos" ]; then
    install_node_macos
  else
    install_node_linux
  fi
  has_supported_node || fail "Node.js installation finished, but Node.js >= $MIN_NODE_MAJOR with npm/npx is not available"
  log "Installed Node.js $(node --version)"
fi

PACKAGE_SPEC="$PAPERCLIP_PACKAGE@latest"
if [ "$CANARY" = "1" ]; then
  PACKAGE_SPEC="$PAPERCLIP_PACKAGE@canary"
elif [ -n "$VERSION" ]; then
  PACKAGE_SPEC="$PAPERCLIP_PACKAGE@$VERSION"
fi

INSTALL_ARGS=(install)
[ "$CANARY" = "1" ] && INSTALL_ARGS+=(--canary)
[ -n "$VERSION" ] && INSTALL_ARGS+=(--version "$VERSION")
[ "$NO_PROMPT" = "1" ] && INSTALL_ARGS+=(--yes)
INSTALL_COMMAND=(npx --yes "$PACKAGE_SPEC" "${INSTALL_ARGS[@]}")

log "Delegating to the Paperclip CLI"
if [ "$DRY_RUN" = "1" ]; then
  print_command "${INSTALL_COMMAND[@]}"
  exit 0
fi

print_command "${INSTALL_COMMAND[@]}"
"${INSTALL_COMMAND[@]}"

if [ "$INSTALL_SERVICE" = "1" ]; then
  log "Installing the Paperclip service"
  print_command npx --yes "$PACKAGE_SPEC" service install
  npx --yes "$PACKAGE_SPEC" service install
fi

if [ "$NO_ONBOARD" = "0" ] && [ -t 0 ] && [ -t 1 ]; then
  if command -v paperclipai >/dev/null 2>&1; then
    exec paperclipai onboard
  elif [ -x "${HOME:-}/.local/bin/paperclipai" ]; then
    exec "${HOME}/.local/bin/paperclipai" onboard
  else
    fail "Paperclip was installed, but 'paperclipai' is not available on PATH. Open a new shell and run 'paperclipai onboard'."
  fi
fi

if [ "$NO_ONBOARD" = "0" ]; then
  log "Installation complete. Next: paperclipai onboard"
else
  log "Installation complete."
fi
