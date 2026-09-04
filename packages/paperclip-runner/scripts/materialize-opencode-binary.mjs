import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OPENCODE_VERSION = "1.18.17";
const BASELINE_PACKAGE = "opencode-linux-x64-baseline";

function readPackage(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertPackage(packageRoot, expectedName) {
  const packageJson = readPackage(join(packageRoot, "package.json"));
  if (
    packageJson.name !== expectedName ||
    packageJson.version !== OPENCODE_VERSION
  ) {
    throw new Error(
      `Expected ${expectedName}@${OPENCODE_VERSION}, received ${String(packageJson.name)}@${String(packageJson.version)}`,
    );
  }
}

export function materializePinnedOpenCodeBinary(options = {}) {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== "linux" || architecture !== "x64") {
    throw new Error(
      `Pinned OpenCode materialization requires linux/x64, received ${platform}/${architecture}`,
    );
  }

  const packageRoot = realpathSync(
    options.packageRoot ??
      resolve(import.meta.dirname, "../node_modules/opencode-ai"),
  );
  const dependencyRoot = dirname(packageRoot);
  const baselineRoot = realpathSync(join(dependencyRoot, BASELINE_PACKAGE));
  assertPackage(packageRoot, "opencode-ai");
  assertPackage(baselineRoot, BASELINE_PACKAGE);

  const source = join(baselineRoot, "bin", "opencode");
  const target = join(packageRoot, "bin", "opencode.exe");
  if (!lstatSync(source).isFile()) {
    throw new Error("Pinned OpenCode source executable is not a regular file");
  }
  if (existsSync(target)) {
    if (!lstatSync(target).isFile()) {
      throw new Error("OpenCode target executable is not a regular file");
    }
    unlinkSync(target);
  }
  try {
    linkSync(source, target);
  } catch (error) {
    const code = error?.code;
    if (!new Set(["EACCES", "EMLINK", "EPERM", "EXDEV"]).has(code)) {
      throw error;
    }
    copyFileSync(source, target);
  }
  chmodSync(target, 0o755);

  const sourceDigest = sha256(source);
  const targetDigest = sha256(target);
  if (sourceDigest !== targetDigest) {
    throw new Error("Materialized OpenCode executable digest mismatch");
  }
  const targetStat = lstatSync(target);
  const mode = targetStat.mode & 0o777;
  if (!targetStat.isFile() || (mode & 0o111) === 0 || mode & 0o022) {
    throw new Error("Materialized OpenCode executable has unsafe permissions");
  }

  const version = spawnSync(target, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (version.status !== 0 || version.stdout.trim() !== OPENCODE_VERSION) {
    throw new Error(
      `Materialized OpenCode executable did not report ${OPENCODE_VERSION}`,
    );
  }
  return { sourceDigest, target, version: OPENCODE_VERSION };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  const result = materializePinnedOpenCodeBinary();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
