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
//
// The tarball's SHA-256 is checked against the digests pinned below (from the
// release's GPG-signed SHASUMS256.txt) before it is extracted; a mismatch aborts
// the whole install rather than falling through to an unverified runtime.
// v24.22.1 carries the 2026-10-21 Node security fixes (Brotli decoder RCE, TLS
// hostname checks, eMudhra CA key block). To bump: set the version and copy the
// two `linux-*.tar.xz` lines from https://nodejs.org/dist/<version>/SHASUMS256.txt
// after verifying its signature.
export const SANDBOX_NODE_VERSION = "v24.22.1";

export const SANDBOX_NODE_SHA256: Readonly<Record<"x64" | "arm64", string>> = {
  x64: "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6",
  arm64: "dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e",
};

export function buildEnsureNpmPreamble(
  nodeVersion: string = SANDBOX_NODE_VERSION,
  sha256ByArch: Readonly<Record<string, string>> = SANDBOX_NODE_SHA256,
): string {
  const hashCases = Object.entries(sha256ByArch)
    .map(([arch, sha]) => `${arch}) NODE_SHA=${sha} ;; `)
    .join("");
  return (
    "PAPERCLIP_NPM_BOOTSTRAPPED=; " +
    "if ! command -v npm >/dev/null 2>&1 || " +
    "! command -v node >/dev/null 2>&1 || " +
    "! node -e 'const v=process.versions.node.split(\".\").map(Number);" +
    "process.exit(v[0]>24||(v[0]===24&&v[1]>=11)?0:1)' >/dev/null 2>&1; then " +
    'NODE_ARCH="$(uname -m)"; ' +
    'case "$NODE_ARCH" in ' +
    "x86_64) NODE_ARCH=x64 ;; " +
    "aarch64|arm64) NODE_ARCH=arm64 ;; " +
    "esac; " +
    `NODE_VERSION="${nodeVersion}"; ` +
    "NODE_SHA=; " +
    `case "$NODE_ARCH" in ${hashCases}esac; ` +
    'if [ -z "$NODE_SHA" ]; then echo "node bootstrap: no pinned checksum for linux-$NODE_ARCH" >&2; exit 1; fi; ' +
    'NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; ' +
    'NODE_TMP="$(mktemp -d)"; ' +
    'mkdir -p "$HOME/.local"; ' +
    'curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}" -o "$NODE_TMP/$NODE_TARBALL" || { rm -rf "$NODE_TMP"; exit 1; }; ' +
    'if command -v sha256sum >/dev/null 2>&1; then NODE_GOT="$(sha256sum "$NODE_TMP/$NODE_TARBALL" | cut -d" " -f1)"; ' +
    'else NODE_GOT="$(shasum -a 256 "$NODE_TMP/$NODE_TARBALL" | cut -d" " -f1)"; fi; ' +
    'if [ "$NODE_GOT" != "$NODE_SHA" ]; then echo "node bootstrap: checksum mismatch for $NODE_TARBALL (expected $NODE_SHA, got $NODE_GOT)" >&2; rm -rf "$NODE_TMP"; exit 1; fi; ' +
    'tar -xJf "$NODE_TMP/$NODE_TARBALL" -C "$HOME/.local" --strip-components=1 && ' +
    'rm -rf "$NODE_TMP" && ' +
    'export PATH="$HOME/.local/bin:$PATH" && ' +
    "PAPERCLIP_NPM_BOOTSTRAPPED=1; " +
    "fi;"
  );
}

const ENSURE_NPM_PREAMBLE = buildEnsureNpmPreamble();

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
