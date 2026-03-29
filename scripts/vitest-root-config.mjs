import { existsSync } from "node:fs";
import path from "node:path";

const LEGACY_MIRROR_DIRNAME = "paperclip-orginal";

const REQUIRED_WORKSPACE_MANIFESTS = [
  "packages/db/package.json",
  "packages/shared/package.json",
  "packages/adapter-utils/package.json",
  "packages/adapters/codex-local/package.json",
  "packages/adapters/cursor-local/package.json",
  "packages/adapters/opencode-local/package.json",
];

const ROOT_PROJECT_PATHS = [
  "packages/db",
  "packages/shared",
  "packages/adapters/opencode-local",
  "server",
  "ui",
  "cli",
];

const COMMON_EXCLUDE_GLOBS = [
  "**/node_modules/**",
  "**/.paperclip/workspaces/**",
  "**/tests/release-smoke/**",
];

const ROOT_ONLY_EXCLUDE_GLOBS = ["**/paperclip-orginal/**"];

const CRITICAL_IMPORT_ALIASES = {
  "@paperclipai/db": "packages/db/src/index.ts",
  "@paperclipai/shared": "packages/shared/src/index.ts",
  "@paperclipai/adapter-utils": "packages/adapter-utils/src/index.ts",
  "@paperclipai/adapter-utils/server-utils": "packages/adapter-utils/src/server-utils.ts",
  "@paperclipai/adapter-codex-local/server": "packages/adapters/codex-local/src/server/index.ts",
  "@paperclipai/adapter-cursor-local/server": "packages/adapters/cursor-local/src/server/index.ts",
  "@paperclipai/plugin-sdk": "packages/plugins/sdk/src/index.ts",
  "@paperclipai/plugin-sdk/protocol": "packages/plugins/sdk/src/protocol.ts",
  "@paperclipai/plugin-sdk/types": "packages/plugins/sdk/src/types.ts",
  "@paperclipai/plugin-sdk/ui": "packages/plugins/sdk/src/ui/index.ts",
  "@paperclipai/plugin-sdk/ui/hooks": "packages/plugins/sdk/src/ui/hooks.ts",
  "@paperclipai/plugin-sdk/ui/types": "packages/plugins/sdk/src/ui/types.ts",
  "@paperclipai/plugin-sdk/testing": "packages/plugins/sdk/src/testing.ts",
  "@paperclipai/plugin-sdk/bundlers": "packages/plugins/sdk/src/bundlers.ts",
  "@paperclipai/plugin-sdk/dev-server": "packages/plugins/sdk/src/dev-server.ts",
};

function findMissingWorkspaceManifests(baseDir, fileExists) {
  return REQUIRED_WORKSPACE_MANIFESTS.filter((relativePath) =>
    !fileExists(path.join(baseDir, relativePath)));
}

function buildMissingManifestError({ repoRoot, missingManifests, mirrorHasManifests }) {
  const lines = [
    "Root verification gate failed before Vitest started.",
    "",
    `- Missing workspace manifests in root: ${missingManifests.join(", ")}`,
  ];

  if (mirrorHasManifests) {
    lines.push(
      `- Detected ${LEGACY_MIRROR_DIRNAME}/ with workspace manifests. Do not use it as fallback discovery.`,
    );
  }

  lines.push("");
  lines.push(
    "Run the gate from a clean candidate worktree/ref (example: ./scripts/qa-gate.sh --candidate-ref HEAD).",
  );
  lines.push(`Root checked: ${repoRoot}`);
  return lines.join("\n");
}

export function resolveVitestSourceRoot({
  repoRoot = process.cwd(),
  fileExists = existsSync,
} = {}) {
  const missingManifests = findMissingWorkspaceManifests(repoRoot, fileExists);
  if (missingManifests.length === 0) {
    return path.resolve(repoRoot);
  }

  const legacyMirrorRoot = path.join(repoRoot, LEGACY_MIRROR_DIRNAME);
  const mirrorHasManifests = findMissingWorkspaceManifests(legacyMirrorRoot, fileExists).length === 0;

  throw new Error(
    buildMissingManifestError({
      repoRoot: path.resolve(repoRoot),
      missingManifests,
      mirrorHasManifests,
    }),
  );
}

function buildVitestProjects({ repoRoot, sourceRoot }) {
  return ROOT_PROJECT_PATHS.map((relativePath) =>
    path.relative(repoRoot, path.join(sourceRoot, relativePath)).split(path.sep).join("/"),
  );
}

function buildVitestExclude({ repoRoot, sourceRoot }) {
  return sourceRoot === repoRoot
    ? [...COMMON_EXCLUDE_GLOBS, ...ROOT_ONLY_EXCLUDE_GLOBS]
    : [...COMMON_EXCLUDE_GLOBS];
}

function buildVitestAlias(sourceRoot) {
  return Object.fromEntries(
    Object.entries(CRITICAL_IMPORT_ALIASES).map(([specifier, relativePath]) => [
      specifier,
      path.join(sourceRoot, relativePath),
    ]),
  );
}

export function resolveVitestRootConfigContext({
  repoRoot = process.cwd(),
  fileExists = existsSync,
} = {}) {
  const sourceRoot = resolveVitestSourceRoot({ repoRoot, fileExists });
  return {
    sourceRoot,
    projects: buildVitestProjects({ repoRoot, sourceRoot }),
    exclude: buildVitestExclude({ repoRoot, sourceRoot }),
    alias: buildVitestAlias(sourceRoot),
  };
}
