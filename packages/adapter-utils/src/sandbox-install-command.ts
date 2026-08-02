function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

// Bootstrap a usable npm when the sandbox image ships without one (e.g. the
// default exe.dev VM image has sshd + a normal user homedir but no Node
// toolchain). We install a portable Node tarball into $HOME/.local rather
// than using apt-get because the distro-packaged Node is often old enough to
// reject modern JS syntax (regex /v flag, etc.) used by adapter CLIs like
// @google/gemini-cli. The bootstrap also sets PAPERCLIP_NPM_BOOTSTRAPPED=1
// so the install step knows to skip sudo — sudo would reset PATH via
// secure_path and lose visibility of the freshly-installed npm in
// $HOME/.local/bin.
const ENSURE_NPM_PREAMBLE =
  "PAPERCLIP_NPM_BOOTSTRAPPED=; " +
  'if ! command -v npm >/dev/null 2>&1; then ' +
  'NODE_ARCH="$(uname -m)"; ' +
  'case "$NODE_ARCH" in ' +
  "x86_64) NODE_ARCH=x64 ;; " +
  "aarch64|arm64) NODE_ARCH=arm64 ;; " +
  "esac; " +
  'NODE_VERSION="v22.11.0"; ' +
  'NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; ' +
  'mkdir -p "$HOME/.local"; ' +
  'curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}" -o "/tmp/${NODE_TARBALL}" && ' +
  'tar -xJf "/tmp/${NODE_TARBALL}" -C "$HOME/.local" --strip-components=1 && ' +
  'rm -f "/tmp/${NODE_TARBALL}" && ' +
  'export PATH="$HOME/.local/bin:$PATH" && ' +
  "PAPERCLIP_NPM_BOOTSTRAPPED=1; " +
  "fi;";

export function buildSandboxNpmInstallCommand(packageName: string): string {
  const quotedPackageName = shellSingleQuote(packageName);
  return [
    ENSURE_NPM_PREAMBLE,
    'if [ -n "$PAPERCLIP_NPM_BOOTSTRAPPED" ]; then',
    `npm install -g ${quotedPackageName};`,
    'elif [ "$(id -u)" -eq 0 ]; then',
    `npm install -g ${quotedPackageName};`,
    'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then',
    `sudo -E npm install -g ${quotedPackageName};`,
    "else",
    `mkdir -p "$HOME/.local" && npm install -g --prefix "$HOME/.local" ${quotedPackageName};`,
    "fi",
  ].join(" ");
}
