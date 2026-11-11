import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The pinned upstream has token-gate debt. Report it and reject violations in
// every file changed by this fork; do not describe this as a clean global gate.
const cwd = fileURLToPath(new URL("../", import.meta.url));
const base = "c8ae02e5ce42c254e1d56dd4d1b34bd73e1a415b";
const changed = new Set([
  ...execFileSync("git", ["diff", "--name-only", base], { cwd, encoding: "utf8" }).trim().split(/\r?\n/),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" }).trim().split(/\r?\n/),
]);
const result = spawnSync(process.execPath, ["scripts/check-token-gates.mjs"], { cwd, encoding: "utf8" });
const report = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(report);
if (result.error || result.status === null || ![0, 1].includes(result.status)) {
  throw result.error ?? new Error(`Token scanner failed: ${result.status}`);
}
const violations = [...report.matchAll(/^\s+(ui\/[^:\n]+):\d+\s+/gm)].map(match => match[1]);
if (result.status === 1 && !violations.length) throw new Error("Token scanner failed without a recognized report");
const introduced = [...new Set(violations.filter(file => changed.has(file)))];
if (introduced.length) {
  console.error(`Token violations in changed files: ${introduced.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`Fork token check passed. ${violations.length} reported violations remain in unchanged upstream files.`);
}
