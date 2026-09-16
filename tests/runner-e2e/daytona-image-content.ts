import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export const DAYTONA_IMAGE_CONTENT_SCHEMA =
  "paperclip-daytona-runner-image-content/v6";
export const DAYTONA_IMAGE_PLATFORM = "linux/amd64";
export const DAYTONA_IMAGE_DOCKERFILE_PATH = "docker/daytona-runner/Dockerfile";

// Hash the provider build dependency closure: the complete copied manifest
// graph and immutable provider lock, plus the runner/eval runtime build inputs.
// The contract test checks copied package manifests against this explicit list;
// unrelated application source is not part of the provider output.
export const DAYTONA_IMAGE_INPUT_PATHS = [
  ".dockerignore",
  ".npmrc",
  "docker/daytona-runner/Dockerfile",
  "package.json",
  "patches",
  "docker/daytona-runner/provider-dependencies.lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/link-plugin-dev-sdk.mjs",
  "tsconfig.base.json",
  "server/package.json",
  "ui/package.json",
  "cli/package.json",
  "packages/adapter-utils/package.json",
  "packages/adapters/claude-local/package.json",
  "packages/adapters/codex-local/package.json",
  "packages/adapters/cursor-cloud/package.json",
  "packages/adapters/cursor-local/package.json",
  "packages/adapters/gemini-local/package.json",
  "packages/adapters/grok-local/package.json",
  "packages/adapters/hermes-gateway/package.json",
  "packages/adapters/hermes/package.json",
  "packages/adapters/kimi-local/package.json",
  "packages/adapters/openclaw-gateway/package.json",
  "packages/adapters/opencode-local/package.json",
  "packages/adapters/pi-local/package.json",
  "packages/db/package.json",
  "packages/google-sheets-mcp-server/package.json",
  "packages/kv-demo-mcp-server/package.json",
  "packages/mcp-server/package.json",
  "packages/paperclip-eval-kernel/package.json",
  "packages/paperclip-runner/package.json",
  "packages/plugins/create-paperclip-plugin/package.json",
  "packages/plugins/examples/plugin-authoring-smoke-example/package.json",
  "packages/plugins/examples/plugin-file-browser-example/package.json",
  "packages/plugins/examples/plugin-hello-world-example/package.json",
  "packages/plugins/examples/plugin-kitchen-sink-example/package.json",
  "packages/plugins/examples/plugin-orchestration-smoke-example/package.json",
  "packages/plugins/paperclip-plugin-fake-sandbox/package.json",
  "packages/plugins/plugin-llm-wiki/package.json",
  "packages/plugins/plugin-workspace-diff/package.json",
  "packages/plugins/sandbox-providers/cloudflare/bridge-template/package.json",
  "packages/plugins/sandbox-providers/cloudflare/package.json",
  "packages/plugins/sandbox-providers/daytona/package.json",
  "packages/plugins/sandbox-providers/e2b/package.json",
  "packages/plugins/sandbox-providers/exe-dev/package.json",
  "packages/plugins/sandbox-providers/kubernetes/package.json",
  "packages/plugins/sandbox-providers/modal/package.json",
  "packages/plugins/sandbox-providers/novita/package.json",
  "packages/plugins/sdk/package.json",
  "packages/shared/package.json",
  "packages/skills-catalog/package.json",
  "packages/tailscale-https-broker/package.json",
  "packages/teams-catalog/package.json",
  "packages/paperclip-eval-kernel/src",
  "packages/paperclip-eval-kernel/tsconfig.json",
  "packages/paperclip-runner/protocol",
  "packages/paperclip-runner/runner/Cargo.lock",
  "packages/paperclip-runner/runner/Cargo.toml",
  "packages/paperclip-runner/runner/crates",
  "packages/paperclip-runner/scripts/acpx-sidecar-contract.mjs",
  "packages/paperclip-runner/scripts/build-provider-pack.mjs",
  "packages/paperclip-runner/scripts/assemble-provider-pack.mjs",
  "packages/paperclip-runner/scripts/provider-pack-integrity.mjs",
  "packages/paperclip-runner/scripts/provider-pack-layout.mjs",
  "packages/paperclip-runner/scripts/materialize-pi-binary.mjs",
  "packages/paperclip-runner/scripts/portable-provider-shim.mjs",
  "packages/paperclip-runner/scripts/verify-pi-provider-launch.mjs",
  "packages/paperclip-runner/scripts/build-verified-provider-entrypoints.mjs",
  "packages/paperclip-runner/scripts/generate-acpx-sidecar-contract.mjs",
  "packages/paperclip-runner/scripts/generate-protocol-schema-module.mjs",
  "packages/paperclip-runner/src",
  "packages/paperclip-runner/styles.css",
  "packages/paperclip-runner/tsconfig.json",
  "packages/paperclip-runner/tsconfig.surfaces.json",
] as const;

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
    // Docker's scratch is the built-in empty filesystem, not a registry image.
    // Its declaration remains covered by the Dockerfile content hash.
    if (reference !== "scratch" && !stageAliases.has(reference)) {
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
