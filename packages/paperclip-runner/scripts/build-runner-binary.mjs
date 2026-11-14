import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageRunnerBinary } from "./stage-runner-binary.mjs";

export const RELEASE_ARTIFACTS_VARIABLE = "PAPERCLIP_RELEASE_RUNNER_ARTIFACTS_DIR";

export function hostRunnerTarget(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

export async function stageReleaseHostBinary({ artifactDirectory, sourceRevision, packageRoot, verifyMetadata, target = hostRunnerTarget() }) {
  const { releaseDaemonManifest } = await import("./stage-release-runner-binaries.mjs");
  const manifest = releaseDaemonManifest(artifactDirectory, sourceRevision, verifyMetadata);
  const artifact = manifest.platforms[target];
  if (!artifact) throw new Error(`No exact-source release daemon for ${target}`);
  const executable = target.startsWith("win32-") ? "paperclip-runnerd.exe" : "paperclip-runnerd";
  await stageRunnerBinary(artifact.path, path.join(packageRoot, "dist", "bin", executable));
  return { target, sha256: artifact.sha256 };
}

function pnpmInvocation(env) {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && npmExecPath.toLowerCase().includes("pnpm")) {
    return /\.(c|m)?js$/i.test(npmExecPath) ? { command: process.execPath, args: [npmExecPath] } : { command: npmExecPath, args: [] };
  }
  return { command: "pnpm", args: [] };
}

export async function main({ env = process.env, packageRoot, log = console.log } = {}) {
  const root = packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const artifactDirectory = env[RELEASE_ARTIFACTS_VARIABLE]?.trim();
  if (artifactDirectory) {
    const { metadataContract } = await import("./stage-release-runner-binaries.mjs");
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const staged = await stageReleaseHostBinary({ artifactDirectory, sourceRevision, packageRoot: root, verifyMetadata: await metadataContract() });
    log(`Staged the verified exact-source ${staged.target} release daemon (${staged.sha256}) instead of compiling it.`);
    return { reused: true, ...staged };
  }
  const { command, args } = pnpmInvocation(env);
  const result = spawnSync(command, [...args, "run", "build:binary"], { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" && command === "pnpm" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`build:binary exited with ${result.status ?? result.signal}`);
  return { reused: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
