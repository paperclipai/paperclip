// Assemble the three independently built release daemons before npm packing.
// Usage: node packages/paperclip-runner/scripts/stage-release-runner-binaries.mjs MANIFEST.json
// Manifest: {sourceRevision, platforms: {"darwin-arm64": {path, sha256}, ...}}.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerBinaryTarget } from "../src/live/runner-binary.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = ["darwin-arm64", "darwin-x64", "linux-x64"];
if (process.argv.length !== 3) throw Error("Usage: stage-release-runner-binaries.mjs MANIFEST.json");
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!/^[a-f0-9]{40}$/.test(manifest.sourceRevision) || !manifest.platforms || Object.keys(manifest.platforms).sort().join() !== [...required].sort().join()) throw Error("Release daemon manifest must bind one source and all three supported targets");
const verified = required.map(target => {
  const artifact = manifest.platforms[target];
  if (!artifact || !isAbsolute(artifact.path) || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)) throw Error(`Invalid ${target} release artifact`);
  const bytes = readFileSync(artifact.path), sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== artifact.sha256 || runnerBinaryTarget(bytes) !== target) throw Error(`Release daemon ${target} digest or architecture mismatch`);
  return { target, source: artifact.path, sha256 };
});
const platforms = {};
for (const artifact of verified) {
  const relative = `${artifact.target}/paperclip-runnerd`, destination = join(root, "dist", "bin", relative);
  mkdirSync(dirname(destination), { recursive: true }); copyFileSync(artifact.source, destination); chmodSync(destination, 0o755);
  // Copied Mach-O inodes need a fresh ad-hoc signature on macOS. Record the
  // resulting packaged bytes, as well as the verified build artifact identity.
  if (process.platform === "darwin" && artifact.target.startsWith("darwin-")) {
    execFileSync("codesign", ["--force", "--sign", "-", destination], { stdio: "pipe" });
  }
  const sha256 = "sha256:" + createHash("sha256").update(readFileSync(destination)).digest("hex");
  platforms[artifact.target] = { path: relative, sha256, sourceSha256: artifact.sha256 };
}
writeFileSync(join(root, "dist", "bin", "release-manifest.json"), JSON.stringify({schema:"paperclip.runner.release-binaries.v1",sourceRevision:manifest.sourceRevision,platforms},null,2)+"\n");
console.log("Staged verified release daemons for " + required.join(", "));
