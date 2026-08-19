import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const selfExcludedFiles = new Set([
  "scripts/check-numbered-milestones.test.mjs",
  "scripts/lib/numbered-milestones.mjs",
]);

export const defaultPackageRoot = resolve(
  new URL("../..", import.meta.url).pathname,
);

export function findNumberedMilestoneNames(value) {
  const matcher = new RegExp(String.raw`\bphases?[\s._/-]*0*\d+[a-z]?`, "gi");
  return [...value.matchAll(matcher)].map((match) => ({
    index: match.index ?? 0,
    value: match[0],
  }));
}

export async function listTrackedPackageFiles(packageRoot = defaultPackageRoot) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", "."], {
    cwd: packageRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

export async function checkNumberedMilestones({
  packageRoot = defaultPackageRoot,
  trackedFiles,
} = {}) {
  const files = trackedFiles ?? await listTrackedPackageFiles(packageRoot);
  const violations = [];

  for (const relativePath of files) {
    for (const match of findNumberedMilestoneNames(relativePath)) {
      violations.push({
        kind: "path",
        file: relativePath,
        line: 1,
        value: match.value,
      });
    }

    if (!textExtensions.has(extname(relativePath)) || selfExcludedFiles.has(relativePath)) {
      continue;
    }

    const contents = await readFile(resolve(packageRoot, relativePath), "utf8");
    for (const match of findNumberedMilestoneNames(contents)) {
      violations.push({
        kind: "content",
        file: relativePath,
        line: contents.slice(0, match.index).split("\n").length,
        value: match.value,
      });
    }
  }

  return violations;
}

export function formatNumberedMilestoneViolation(violation) {
  return `${violation.file}:${violation.line} contains numbered milestone label ${JSON.stringify(violation.value)}`;
}
