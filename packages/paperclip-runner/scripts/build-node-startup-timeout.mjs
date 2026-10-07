/** Build-time probes only; provider/session admission deadlines are unchanged. */
export function buildNodeStartupTimeout(platform = process.platform, architecture = process.arch) {
  // A freshly copied x64 Node can spend more than 10s in Rosetta's first launch.
  // Keep this bounded and target-specific instead of weakening other probes.
  return platform === "darwin" && architecture === "x64" ? 30_000 : 10_000;
}
