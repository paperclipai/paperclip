// The trusted qualification workflow invokes this target-owned entry point.
// Never assemble from that job's CI-resolved lock, node_modules, shared dist,
// or setup-node interpreter: the image's isolated stage is the source of truth.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, verifyProviderPack } from "./provider-pack-integrity.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultWorkspaceRoot = resolve(packageRoot, "../..");

export function buildProviderPack({ workspaceRoot = defaultWorkspaceRoot, outputRoot = join(packageRoot, "provider-pack"),
  revision = process.env.PAPERCLIP_RUNNER_SOURCE_REVISION?.trim(), run = spawnSync } = {}) {
  workspaceRoot = realpathSync(workspaceRoot);
  outputRoot = resolve(outputRoot);
  const missingSegments = [];
  let existingParent = outputRoot;
  while (!existsSync(existingParent)) { missingSegments.unshift(basename(existingParent)); existingParent = dirname(existingParent); }
  outputRoot = join(realpathSync(existingParent), ...missingSegments);
  const sourcePackage = join(workspaceRoot, "packages/paperclip-runner");
  function contains(base, target) {
    const child = relative(base, target);
    return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
  }
  if (outputRoot === dirname(outputRoot) || contains(outputRoot, workspaceRoot)
    || (contains(workspaceRoot, outputRoot) && outputRoot !== join(sourcePackage, "provider-pack"))) {
    throw new Error("Refusing unsafe provider-pack output path");
  }
  if (revision === undefined) {
    // CI supplies an authorized revision explicitly and may refresh only its
    // root lock. Local implicit HEAD must not mislabel changed image inputs.
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--",
      ".dockerignore", "docker/daytona-runner", "package.json", "pnpm-workspace.yaml", ".npmrc", "tsconfig.base.json",
      "patches", "scripts/link-plugin-dev-sdk.mjs", "packages", "server/package.json", "ui/package.json", "cli/package.json",
      ":(exclude)packages/paperclip-runner/provider-pack", ":(glob,exclude)packages/paperclip-runner/.paperclip-provider-pack-*/**"],
    { cwd: workspaceRoot, encoding: "utf8" });
    if (dirty.trim()) throw new Error("Canonical provider inputs are dirty; an implicit HEAD revision would be misleading");
    revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf8" }).trim();
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("PAPERCLIP_RUNNER_SOURCE_REVISION must be a full Git SHA");
  const dockerfile = join(workspaceRoot, "docker/daytona-runner/Dockerfile");
  const expectedLock = readFileSync(dockerfile, "utf8").match(/^ARG PAPERCLIP_RUNNER_LOCK_SHA256=([a-f0-9]{64})$/m)?.[1];
  if (!expectedLock) throw new Error("Canonical provider lock pin is missing");
  const actualLock = sha256File(join(workspaceRoot, "docker/daytona-runner/provider-dependencies.lock.yaml"));
  if (actualLock !== `sha256:${expectedLock}`) throw new Error("Canonical provider lock integrity mismatch");
  mkdirSync(dirname(outputRoot), { recursive: true });
  // Same filesystem as OUTPUT, so successful publication is an atomic rename.
  // Docker reads its inputs before this empty directory receives exported files.
  const temporaryParent = mkdtempSync(join(dirname(outputRoot), ".paperclip-provider-pack-"));
  const exportRoot = join(temporaryParent, "exported"), exported = join(exportRoot, "provider-pack"), backup = join(temporaryParent, "previous");
  let previousMoved = false, published = false;
  try {
    const build = run("docker", ["build", "--platform", "linux/amd64", "--target", "provider-pack-export",
      "--file", dockerfile, "--build-arg", `PAPERCLIP_RUNNER_SOURCE_REVISION=${revision}`,
      "--output", `type=local,dest=${exportRoot}`, workspaceRoot],
    { cwd: workspaceRoot, stdio: "inherit", timeout: 12 * 60 * 1000, killSignal: "SIGTERM" });
    if (build.error || build.status !== 0) throw new Error("Canonical provider-pack build failed");
    const manifest = verifyProviderPack(exported, { revision, lockSha256: expectedLock });
    if (existsSync(outputRoot)) { renameSync(outputRoot, backup); previousMoved = true; }
    try { renameSync(exported, outputRoot); published = true; }
    catch (error) { if (previousMoved) { renameSync(backup, outputRoot); previousMoved = false; } throw error; }
    return { outputRoot, manifest };
  } finally {
    // If even rollback fails, leave the prior pack in its recoverable backup.
    if (!previousMoved || published) rmSync(temporaryParent, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputArgument = process.argv.slice(2).find((value) => value !== "--");
  const result = buildProviderPack({ outputRoot: resolve(process.cwd(), outputArgument ?? join(packageRoot, "provider-pack")) });
  process.stdout.write(`${result.outputRoot}\n`);
}
