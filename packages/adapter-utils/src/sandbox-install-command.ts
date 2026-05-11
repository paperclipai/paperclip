function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildSandboxNpmInstallCommand(packageName: string): string {
  const quotedPackageName = shellSingleQuote(packageName);
  return [
    'if [ "$(id -u)" -eq 0 ]; then',
    `npm install -g ${quotedPackageName};`,
    'elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then',
    `sudo -E npm install -g ${quotedPackageName};`,
    "else",
    `mkdir -p "$HOME/.local" && npm install -g --prefix "$HOME/.local" ${quotedPackageName};`,
    "fi",
  ].join(" ");
}
