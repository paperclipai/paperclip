import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type ReadTextFile = (path: string) => string;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_BUILD_INFO_PATH = fileURLToPath(
  new URL("./build-info.json", import.meta.url),
);
const DEFAULT_BUILD_COMMIT_PATH = fileURLToPath(
  new URL("../../.paperclip-build-commit", import.meta.url),
);

export function parseBuildCommit(value: string | null | undefined): string | null {
  const commit = value?.trim() ?? "";
  return FULL_SHA_RE.test(commit) ? commit.toLowerCase() : null;
}

export function readBuildCommit(
  opts: {
    environmentCommit?: string | null;
    buildCommitPath?: string;
    readTextFile?: ReadTextFile;
  } = {},
): string | null {
  const environmentCommit = parseBuildCommit(
    opts.environmentCommit === undefined
      ? process.env.PAPERCLIP_BUILD_COMMIT
      : opts.environmentCommit,
  );
  if (environmentCommit) return environmentCommit;

  const readTextFile = opts.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const paths = opts.buildCommitPath
    ? [opts.buildCommitPath]
    : [DEFAULT_BUILD_INFO_PATH, DEFAULT_BUILD_COMMIT_PATH];
  for (const path of paths) {
    try {
      const raw = readTextFile(path);
      if (path === DEFAULT_BUILD_INFO_PATH) {
        const parsed = JSON.parse(raw) as { commit?: unknown };
        const commit = parseBuildCommit(typeof parsed.commit === "string" ? parsed.commit : null);
        if (commit) return commit;
      } else {
        const commit = parseBuildCommit(raw);
        if (commit) return commit;
      }
    } catch {
      // Try the next compatible marker location.
    }
  }
  return null;
}
