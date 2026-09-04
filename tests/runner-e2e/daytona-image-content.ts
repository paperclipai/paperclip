import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export const DAYTONA_IMAGE_CONTENT_SCHEMA =
  "paperclip-daytona-runner-image-content/v4";
export const DAYTONA_IMAGE_PLATFORM = "linux/amd64";
export const DAYTONA_IMAGE_DOCKERFILE_PATH = "docker/daytona-runner/Dockerfile";

// This is the audited dependency closure of docker/daytona-runner/Dockerfile.
// Keep it conservative: a false positive only rebuilds the image, while a
// missing input could incorrectly reuse an incompatible paid-test image.
export const DAYTONA_IMAGE_INPUT_PATHS = [
  ".dockerignore",
  ".npmrc",
  "docker/daytona-runner/Dockerfile",
  "package.json",
  "patches",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/link-plugin-dev-sdk.mjs",
  "tsconfig.base.json",
  "packages/paperclip-eval-kernel",
  "packages/paperclip-runner",
] as const;

const ignoredGeneratedDirectoryPaths = new Set([
  "packages/paperclip-runner/dist",
  "packages/paperclip-runner/runner/target",
]);

// These paths do not contribute to the release runnerd binary or the
// executable/digested provider-pack runtime payload. They are also excluded
// from the real Docker build context by .dockerignore. Keep the two lists in
// lockstep: if a future build starts consuming one of these inputs, Docker must
// fail instead of publishing bytes that the content identity did not hash.
const ignoredRunnerDevelopmentDirectoryPaths = new Set([
  "packages/paperclip-runner/devtools",
  "packages/paperclip-runner/docs",
  "packages/paperclip-runner/examples",
  "packages/paperclip-runner/test",
  "packages/paperclip-runner/test-fixtures",
  "packages/paperclip-runner/test-support",
]);

const runnerDocumentationFilePattern = /\.md$/;
const runnerTestFilePattern = /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/;
const runnerRustIntegrationTestPathPattern =
  /^packages\/paperclip-runner\/runner\/crates\/[^/]+\/tests(?:\/|$)/;
const runnerSmokeScriptPattern =
  /^packages\/paperclip-runner\/scripts\/[^/]+-smoke\.mjs$/;

export interface DaytonaImageContentOptions {
  repositoryRoot?: string;
  inputPaths?: readonly string[];
  platform?: string;
  baseImages?: readonly string[];
  frontendDigest?: string;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function shouldIgnore(relativePath: string): boolean {
  if (ignoredGeneratedDirectoryPaths.has(relativePath)) return true;
  return relativePath.split("/").includes("node_modules");
}

function shouldIgnoreRunnerDevelopmentInput(relativePath: string): boolean {
  if (!relativePath.startsWith("packages/paperclip-runner/")) return false;
  if (ignoredRunnerDevelopmentDirectoryPaths.has(relativePath)) return true;
  return (
    runnerDocumentationFilePattern.test(relativePath) ||
    runnerTestFilePattern.test(relativePath) ||
    runnerRustIntegrationTestPathPattern.test(relativePath) ||
    runnerSmokeScriptPattern.test(relativePath)
  );
}

function updateRecord(
  hash: ReturnType<typeof createHash>,
  kind: string,
  relativePath: string,
  payload = "",
): void {
  hash.update(kind);
  hash.update("\0");
  hash.update(relativePath);
  hash.update("\0");
  hash.update(payload);
  hash.update("\0");
}

function assertPinnedBaseImage(reference: string): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(reference)) {
    throw new Error(
      `Daytona image base must use an immutable sha256 digest: ${reference}`,
    );
  }
}

function assertPinnedFrontendDigest(digest: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(
      `Daytona Dockerfile frontend must use an immutable sha256 digest: ${digest}`,
    );
  }
}

export function extractDaytonaDockerfileFrontendDigest(
  dockerfile: string,
): string {
  const firstLine = dockerfile.split(/\r?\n/, 1)[0] ?? "";
  const match = /^#\s*syntax=\S+@(sha256:[0-9a-f]{64})\s*$/.exec(firstLine);
  if (!match) {
    throw new Error(
      "Daytona Dockerfile first line must pin its syntax frontend to an immutable sha256 digest",
    );
  }
  const digest = match[1]!;
  assertPinnedFrontendDigest(digest);
  return digest;
}

export function extractDaytonaBaseImages(dockerfile: string): string[] {
  const baseImages: string[] = [];
  const stageAliases = new Set<string>();

  for (const line of dockerfile.split(/\r?\n/)) {
    if (!/^\s*FROM\s/i.test(line)) continue;
    const match = /^\s*FROM(?:\s+--\S+)*\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(
      line,
    );
    if (!match) {
      throw new Error(`Cannot parse Daytona Dockerfile FROM line: ${line}`);
    }

    const reference = match[1]!;
    if (!stageAliases.has(reference)) {
      assertPinnedBaseImage(reference);
      baseImages.push(reference);
    }
    if (match[2]) stageAliases.add(match[2]);
  }

  if (baseImages.length === 0) {
    throw new Error("Daytona Dockerfile does not declare a base image");
  }
  return baseImages;
}

async function resolveBaseImages(
  root: string,
  explicitBaseImages?: readonly string[],
): Promise<string[]> {
  const baseImages = explicitBaseImages
    ? [...explicitBaseImages]
    : extractDaytonaBaseImages(
        await readFile(path.join(root, DAYTONA_IMAGE_DOCKERFILE_PATH), "utf8"),
      );
  if (baseImages.length === 0) {
    throw new Error("Daytona image content identity requires a base image");
  }
  for (const reference of baseImages) assertPinnedBaseImage(reference);
  return baseImages.sort(compareNames);
}

async function resolveFrontendDigest(
  root: string,
  explicitFrontendDigest?: string,
): Promise<string> {
  const digest =
    explicitFrontendDigest ??
    extractDaytonaDockerfileFrontendDigest(
      await readFile(path.join(root, DAYTONA_IMAGE_DOCKERFILE_PATH), "utf8"),
    );
  assertPinnedFrontendDigest(digest);
  return digest;
}

async function hashEntry(
  hash: ReturnType<typeof createHash>,
  root: string,
  relativePath: string,
): Promise<void> {
  const normalizedPath = normalizedRelativePath(relativePath);
  if (
    shouldIgnore(normalizedPath) ||
    shouldIgnoreRunnerDevelopmentInput(normalizedPath)
  ) {
    return;
  }

  const absolutePath = path.resolve(root, relativePath);
  const relativeFromRoot = path.relative(root, absolutePath);
  if (
    relativeFromRoot.startsWith(`..${path.sep}`) ||
    relativeFromRoot === ".." ||
    path.isAbsolute(relativeFromRoot)
  ) {
    throw new Error(
      `Daytona image input escapes repository root: ${relativePath}`,
    );
  }

  const stats = await lstat(absolutePath);
  if (stats.isDirectory()) {
    updateRecord(hash, "directory", normalizedPath);
    const entries = await readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      await hashEntry(hash, root, path.join(relativePath, entry.name));
    }
    return;
  }
  if (stats.isSymbolicLink()) {
    updateRecord(hash, "symlink", normalizedPath, await readlink(absolutePath));
    return;
  }
  if (stats.isFile()) {
    const executable =
      (stats.mode & 0o111) === 0 ? "non-executable" : "executable";
    updateRecord(hash, "file", normalizedPath, executable);
    hash.update(await readFile(absolutePath));
    hash.update("\0");
    return;
  }
  throw new Error(`Unsupported Daytona image input type: ${relativePath}`);
}

export async function computeDaytonaImageContentId(
  options: DaytonaImageContentOptions = {},
): Promise<string> {
  const root = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const inputPaths = [
    ...(options.inputPaths ?? DAYTONA_IMAGE_INPUT_PATHS),
  ].sort(compareNames);
  const hash = createHash("sha256");
  updateRecord(
    hash,
    "contract",
    DAYTONA_IMAGE_CONTENT_SCHEMA,
    options.platform ?? DAYTONA_IMAGE_PLATFORM,
  );
  updateRecord(
    hash,
    "dockerfile-frontend",
    await resolveFrontendDigest(root, options.frontendDigest),
  );
  for (const baseImage of await resolveBaseImages(root, options.baseImages)) {
    updateRecord(hash, "base-image", baseImage);
  }
  for (const inputPath of inputPaths) {
    await hashEntry(hash, root, inputPath);
  }
  return hash.digest("hex");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  computeDaytonaImageContentId()
    .then((contentId) => process.stdout.write(`${contentId}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

export const DAYTONA_IMAGE_CONTENT_SCRIPT = fileURLToPath(import.meta.url);
