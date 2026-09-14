import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { defaultPackageRoot, findSpecifiers } from "./forbidden-imports.mjs";

export { defaultPackageRoot };

const execFileAsync = promisify(execFile);

const SCANNED_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
// TypeScript resolves an ESM ".js" specifier against its ".ts" source sibling,
// so a tracked import may legitimately name a file that never exists on disk.
const JS_TO_SOURCE_EXTENSIONS = new Map([
  [".js", [".ts", ".tsx", ".d.ts"]],
  [".jsx", [".tsx", ".d.ts"]],
  [".mjs", [".mts", ".d.mts"]],
  [".cjs", [".cts", ".d.cts"]],
]);
const EXTENSIONLESS_CANDIDATES = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.mjs",
];

function extension(path) {
  const match = path.match(/\.[^./\\]+$/);
  return match?.[0] ?? "";
}

function isScannable(path) {
  return SCANNED_EXTENSIONS.has(extension(path));
}

function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * Every on-disk path a bundler or `tsc` could pick for this specifier. The
 * check only needs one of them to be tracked.
 */
function resolutionCandidates(file, specifier) {
  const base = resolve(dirname(file), specifier);
  const specifierExtension = extension(specifier);
  const sourceExtensions = JS_TO_SOURCE_EXTENSIONS.get(specifierExtension);
  if (sourceExtensions !== undefined) {
    const withoutExtension = base.slice(0, base.length - specifierExtension.length);
    return [base, ...sourceExtensions.map((suffix) => `${withoutExtension}${suffix}`)];
  }
  if (specifierExtension !== "") {
    return [base];
  }
  return [base, ...EXTENSIONLESS_CANDIDATES.map((suffix) => `${base}${suffix}`)];
}

/**
 * Build output is untracked on purpose, so an import that points into an
 * ignored path is not evidence of a missing source file.
 */
async function listIgnoredPaths(packageRoot, paths) {
  if (paths.length === 0) {
    return new Set();
  }
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd: packageRoot,
    input: paths.join("\0"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  // `git check-ignore` exits 1 when nothing matched, which is not a failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed: ${result.stderr}`);
  }
  return new Set(
    result.stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => resolve(packageRoot, entry)),
  );
}

export async function listTrackedFiles(packageRoot = defaultPackageRoot) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--", "."], {
    cwd: packageRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => resolve(packageRoot, entry));
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== "" && !pathFromParent.startsWith("..");
}

/**
 * Reject tracked sources whose relative imports only resolve against files git
 * does not carry. A shared worktree happily builds such a tree while a clean
 * clone of the same commit cannot, so this guard runs on the tracked set only.
 */
export async function checkTrackedImports({
  packageRoot = defaultPackageRoot,
  scanRoots = ["src", "scripts", "devtools", "examples"],
  trackedFiles,
} = {}) {
  const tracked = trackedFiles ?? (await listTrackedFiles(packageRoot));
  const trackedSet = new Set(tracked);
  const roots = scanRoots.map((root) => resolve(packageRoot, root));
  const files = tracked
    .filter((file) => isScannable(file) && roots.some((root) => isInside(root, file)))
    .sort();

  const suspects = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const { specifier, offset } of findSpecifiers(source)) {
      if (!isRelative(specifier) || /[?*]|\$\{/.test(specifier)) {
        continue;
      }
      const candidates = resolutionCandidates(file, specifier);
      if (candidates.some((candidate) => trackedSet.has(candidate))) {
        continue;
      }
      suspects.push({
        file,
        line: source.slice(0, offset).split("\n").length,
        specifier,
        candidates,
      });
    }
  }

  const ignored = await listIgnoredPaths(
    packageRoot,
    [...new Set(suspects.flatMap((suspect) => suspect.candidates))],
  );
  return suspects
    .filter((suspect) => !suspect.candidates.some((candidate) => ignored.has(candidate)))
    .map(({ file, line, specifier, candidates }) => ({
      file,
      line,
      specifier,
      reason: candidates.some((candidate) => existsSync(candidate))
        ? "resolves only to an untracked file, so a clean checkout cannot build it"
        : "does not resolve to any tracked file",
    }));
}

const ENTRY_POINT_TOKEN = /^[A-Za-z0-9._@/-]+\.(?:mjs|cjs|js|jsx|ts|tsx|sh|toml)$/;

/**
 * `package.json` scripts are the other way a commit can depend on a file git
 * does not carry: an ignored or never-added entry point runs fine locally and
 * fails immediately in a clean checkout.
 */
export async function checkTrackedScriptEntryPoints({
  packageRoot = defaultPackageRoot,
  trackedFiles,
} = {}) {
  const manifestPath = resolve(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const trackedSet = new Set(trackedFiles ?? (await listTrackedFiles(packageRoot)));

  const suspects = [];
  for (const [name, body] of Object.entries(manifest.scripts ?? {})) {
    for (const token of new Set(body.split(/\s+/))) {
      if (!ENTRY_POINT_TOKEN.test(token) || token.startsWith("@")) {
        continue;
      }
      const path = resolve(packageRoot, token);
      if (trackedSet.has(path) || !isInside(packageRoot, path)) {
        continue;
      }
      suspects.push({ file: manifestPath, script: name, specifier: token, candidates: [path] });
    }
  }

  const ignored = await listIgnoredPaths(
    packageRoot,
    suspects.map((suspect) => suspect.candidates[0]),
  );
  return suspects
    .filter((suspect) => !ignored.has(suspect.candidates[0]))
    .map(({ file, script, specifier }) => ({
      file,
      line: 1,
      specifier,
      reason: `the "${script}" script runs a file that is not tracked, so a clean checkout cannot run it`,
    }));
}

export function formatTrackedImportViolation(violation, packageRoot = defaultPackageRoot) {
  return `${relative(packageRoot, violation.file)}:${violation.line} imports ${JSON.stringify(
    violation.specifier,
  )}: ${violation.reason}`;
}
