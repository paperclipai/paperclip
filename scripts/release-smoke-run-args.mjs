export function normalizeReleaseSmokeArgs(args) {
  const normalized = [...args];
  while (normalized[0] === "--") {
    normalized.shift();
  }
  return normalized;
}
