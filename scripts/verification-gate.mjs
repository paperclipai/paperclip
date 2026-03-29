import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const ROOT_REQUIRED_FILES = [
  "cli/package.json",
  "packages/adapter-utils/package.json",
  "pnpm-workspace.yaml",
  "vitest.config.ts",
];

export const ROOT_REQUIRED_WORKSPACE_MANIFESTS = [
  "packages/db/package.json",
  "packages/shared/package.json",
  "packages/adapter-utils/package.json",
  "packages/adapters/codex-local/package.json",
  "packages/adapters/cursor-local/package.json",
  "packages/adapters/opencode-local/package.json",
];

export const LEGACY_MIRROR_DIRNAME = "paperclip-orginal";

function runGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultDirectoryExists(candidatePath) {
  try {
    return statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeRelativePath(candidatePath, repoRoot) {
  return path.relative(repoRoot, candidatePath).split(path.sep).join("/");
}

export function parseTrackedStatusEntries(statusPorcelain) {
  if (!statusPorcelain.trim()) return [];
  return statusPorcelain
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.length >= 4)
    .filter((line) => line.slice(0, 2) !== "??")
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).trim(),
    }));
}

export function findMissingFiles(repoRoot, requiredRelativePaths, fileExists = existsSync) {
  return requiredRelativePaths.filter((relativePath) => !fileExists(path.join(repoRoot, relativePath)));
}

export function evaluateRootGateSafety(input) {
  const repoRoot = path.resolve(input.repoRoot);
  const fileExists = input.fileExists ?? existsSync;
  const directoryExists = input.directoryExists ?? defaultDirectoryExists;
  const statusPorcelain = input.gitStatusPorcelain
    ?? runGit(repoRoot, ["status", "--porcelain", "--untracked-files=no"]);

  const trackedChanges = parseTrackedStatusEntries(statusPorcelain);
  const missingRequiredFiles = findMissingFiles(repoRoot, ROOT_REQUIRED_FILES, fileExists);
  const missingWorkspaceManifests = findMissingFiles(repoRoot, ROOT_REQUIRED_WORKSPACE_MANIFESTS, fileExists);

  const mirrorRoot = path.join(repoRoot, LEGACY_MIRROR_DIRNAME);
  const mirrorPresent = directoryExists(mirrorRoot);
  const mirrorHasWorkspaceManifests = mirrorPresent
    && ROOT_REQUIRED_WORKSPACE_MANIFESTS.some((relativePath) => fileExists(path.join(mirrorRoot, relativePath)));

  const problems = [];

  if (trackedChanges.length > 0) {
    const preview = trackedChanges
      .slice(0, 8)
      .map((entry) => `${entry.status} ${entry.path}`)
      .join(", ");
    const more = trackedChanges.length > 8 ? ` (+${trackedChanges.length - 8} more)` : "";
    problems.push(`tracked git changes detected at root: ${preview}${more}`);
  }

  if (missingRequiredFiles.length > 0) {
    problems.push(
      `required root files are missing: ${missingRequiredFiles.join(", ")}`,
    );
  }

  if (missingWorkspaceManifests.length > 0) {
    problems.push(
      `required workspace manifests are missing: ${missingWorkspaceManifests.join(", ")}`,
    );
  }

  if (mirrorHasWorkspaceManifests) {
    const mirrorRelative = normalizeRelativePath(mirrorRoot, repoRoot);
    problems.push(
      `legacy mirror workspace detected at ${mirrorRelative}; root gate must not treat ${LEGACY_MIRROR_DIRNAME} as a verification source`,
    );
  }

  return {
    ok: problems.length === 0,
    repoRoot,
    rootDirty: trackedChanges.length > 0,
    trackedChanges,
    missingRequiredFiles,
    missingWorkspaceManifests,
    mirrorPresent,
    mirrorHasWorkspaceManifests,
    problems,
  };
}

export function formatRootGateFailureMessage(result, options = {}) {
  const candidateRef = options.candidateRef ?? "HEAD";
  const hint = options.hint
    ?? `Run the gate against a clean candidate ref (example: ./scripts/qa-gate.sh --candidate-ref ${candidateRef}).`;

  const lines = [
    "Root verification gate failed before test execution.",
    "",
    ...result.problems.map((problem) => `- ${problem}`),
    "",
    hint,
  ];

  return lines.join("\n");
}

export function assertRootGateSafety(input) {
  const result = evaluateRootGateSafety(input);
  if (!result.ok) {
    throw new Error(
      formatRootGateFailureMessage(result, {
        candidateRef: input.candidateRef,
      }),
    );
  }
  return result;
}

export function resolveCandidateCommit(repoRoot, candidateRef) {
  const ref = (candidateRef ?? "HEAD").trim() || "HEAD";
  return runGit(path.resolve(repoRoot), ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export function collectVerificationMetadata(input) {
  const repoRoot = path.resolve(input.repoRoot);
  const verificationPath = path.resolve(input.verificationPath);
  const rootSafety = input.rootSafety ?? evaluateRootGateSafety({ repoRoot });

  const commitSha = runGit(verificationPath, ["rev-parse", "HEAD"]);
  const branchOrHead = runGit(verificationPath, ["rev-parse", "--abbrev-ref", "HEAD"]);

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    verificationPath,
    candidateRef: input.candidateRef ?? null,
    commitSha,
    branchOrHead,
    rootDirty: rootSafety.rootDirty,
    rootSafetyProblems: rootSafety.problems,
  };
}

export async function writeVerificationMetadata(filePath, metadata) {
  const absolutePath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return absolutePath;
}
