function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildRemotePidLockAcquireScript(lockDirExpr: string, timeoutMessage: string): string[] {
  return [
    "attempts=0",
    `while ! mkdir ${lockDirExpr} 2>/dev/null; do`,
    "  holder_pid=\"\"",
    `  if [ -s ${lockDirExpr}/pid ]; then`,
    `    holder_pid="$(cat ${lockDirExpr}/pid 2>/dev/null || true)"`,
    "  fi",
    "  if [ -n \"$holder_pid\" ] && ! kill -0 \"$holder_pid\" 2>/dev/null; then",
    `    rm -rf ${lockDirExpr}`,
    "    continue",
    "  fi",
    "  attempts=$((attempts + 1))",
    "  if [ \"$attempts\" -ge 600 ]; then",
    `    echo ${shellQuote(timeoutMessage)} >&2`,
    "    exit 1",
    "  fi",
    "  sleep 0.05",
    "done",
    `printf '%s\\n' "$$" > ${lockDirExpr}/pid`,
  ];
}

export function buildRemotePidLockCleanupScript(lockDirExpr: string, cleanupLines: string[]): string[] {
  return [
    "cleanup() {",
    ...cleanupLines.map((line) => `  ${line}`),
    `  rm -rf ${lockDirExpr}`,
    "}",
    "trap cleanup EXIT INT TERM",
  ];
}
