import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".rs", ".ts", ".tsx"]);
const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]{0,500}?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\b(?:include|include_str|include_bytes)!\s*\(\s*["']([^"']+)["']\s*\)/g,
  /#\[path\s*=\s*["']([^"']+)["']\]/g,
];

const libraryDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultPackageRoot = resolve(libraryDirectory, "../..");

function extension(path) {
  const match = path.match(/\.[^.\/]+$/);
  return match?.[0] ?? "";
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

async function collectSourceFiles(target) {
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["dist", "node_modules", ".git"].includes(entry.name)) {
      continue;
    }
    const path = resolve(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(path)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

export function findSpecifiers(source) {
  const found = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
      found.push({ specifier: match[1], offset: match.index });
    }
  }
  return found;
}

// The Live console component decision record adapts shadcn/ui and AI Elements
// source rather than adopting their runtimes. These packages would reintroduce
// a second message model or a Tailwind/radix dependency for the demo app.
const BROWSER_FORBIDDEN_PACKAGES = [
  "ai",
  "@ai-sdk",
  "zod",
  "radix-ui",
  "@radix-ui",
  "cmdk",
  "streamdown",
  "shiki",
  "use-stick-to-bottom",
  "class-variance-authority",
  "tailwindcss",
  "nanoid",
];

function isForbiddenBrowserPackage(specifier) {
  return BROWSER_FORBIDDEN_PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function violationReason({ file, packageRoot, specifier }) {
  const relativeFile = relative(packageRoot, file).split(/[\\/]/).join("/");
  const isExampleConsumer = relativeFile.startsWith("examples/");
  const publicRunnerImports = new Set([
    "@paperclipai/paperclip-runner/browser",
    "@paperclipai/paperclip-runner/react",
    "@paperclipai/paperclip-runner/standalone",
    "@paperclipai/paperclip-runner/testing",
    "@paperclipai/paperclip-runner/styles.css",
  ]);
  if (
    specifier.startsWith("@paperclipai/paperclip-runner/") &&
    !publicRunnerImports.has(specifier)
  ) {
    return "runner consumers may import only declared public subpaths";
  }
  if (isExampleConsumer && specifier === "@paperclipai/paperclip-runner") {
    return "runner consumers may import only declared public subpaths";
  }
  if (
    specifier.startsWith("@paperclipai/") &&
    specifier !== "@paperclipai/paperclip-runner" &&
    !publicRunnerImports.has(specifier)
  ) {
    return "Paperclip workspace packages are outside the standalone boundary";
  }

  if (
    ["devtools/browser/", "src/react/", "examples/"].some((root) => relativeFile.includes(root)) &&
    isForbiddenBrowserPackage(specifier)
  ) {
    return "the standalone browser app adapts component source instead of adopting its runtime";
  }

  if (["server", "ui", "cli"].some((root) => specifier === root || specifier.startsWith(`${root}/`))) {
    return "Paperclip application internals are outside the standalone boundary";
  }

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const resolvedImport = resolve(dirname(file), specifier);
    if (!isInside(packageRoot, resolvedImport)) {
      return "relative imports may not escape packages/paperclip-runner";
    }
    const segments = relativeFile.split("/");
    const examplesIndex = segments.indexOf("examples");
    if (examplesIndex >= 0 && segments[examplesIndex + 1] !== undefined) {
      const consumerRoot = resolve(
        packageRoot,
        segments.slice(0, examplesIndex + 2).join("/"),
      );
      if (!isInside(consumerRoot, resolvedImport)) {
        return "example consumers may not deep-import package or demo internals";
      }
    }
  }

  return null;
}

async function manifestViolations(packageRoot) {
  const manifestPath = resolve(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const runtimeDependencyGroups = [
    manifest.dependencies ?? {},
    manifest.optionalDependencies ?? {},
    manifest.peerDependencies ?? {},
  ];
  const runtimeDependencies = new Set(
    runtimeDependencyGroups.flatMap((group) => Object.keys(group)),
  );
  const unreviewedDevelopmentDependencies = Object.keys(
    manifest.devDependencies ?? {},
  ).filter(
    (name) => name.startsWith("@paperclipai/"),
  );
  return [...runtimeDependencies, ...unreviewedDevelopmentDependencies]
    .filter(
      (name) => name.startsWith("@paperclipai/") && name !== "@paperclipai/paperclip-runner",
    )
    .map((specifier) => ({
      file: manifestPath,
      line: 1,
      specifier,
      reason: "workspace dependencies require an explicit standalone-boundary review",
    }));
}

async function cargoManifestViolations(packageRoot, cargoRoots) {
  const violations = [];
  const manifests = [];

  async function collectCargoManifests(target) {
    const entries = await readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      if (["target", "node_modules", ".git"].includes(entry.name)) {
        continue;
      }
      const path = resolve(target, entry.name);
      if (entry.isDirectory()) {
        await collectCargoManifests(path);
      } else if (entry.isFile() && entry.name === "Cargo.toml") {
        manifests.push(path);
      }
    }
  }

  for (const root of cargoRoots) {
    await collectCargoManifests(resolve(packageRoot, root));
  }

  for (const manifest of manifests.sort()) {
    const source = await readFile(manifest, "utf8");
    const pathPattern = /\bpath\s*=\s*["']([^"']+)["']/g;
    for (let match = pathPattern.exec(source); match !== null; match = pathPattern.exec(source)) {
      const dependencyPath = resolve(dirname(manifest), match[1]);
      if (isInside(packageRoot, dependencyPath)) {
        continue;
      }
      violations.push({
        file: manifest,
        line: source.slice(0, match.index).split("\n").length,
        specifier: match[1],
        reason: "Cargo path dependencies may not escape packages/paperclip-runner",
      });
    }
  }

  return violations;
}

export async function checkForbiddenImports({
  packageRoot = defaultPackageRoot,
  scanRoots = ["src", "scripts", "runner", "examples"],
  cargoRoots = ["runner"],
  checkManifest = true,
} = {}) {
  const violations = [];
  const files = [];
  for (const root of scanRoots) {
    files.push(...(await collectSourceFiles(resolve(packageRoot, root))));
  }

  for (const file of files.sort()) {
    const source = await readFile(file, "utf8");
    for (const { specifier, offset } of findSpecifiers(source)) {
      const reason = violationReason({ file, packageRoot, specifier });
      if (reason === null) {
        continue;
      }
      violations.push({
        file,
        line: source.slice(0, offset).split("\n").length,
        specifier,
        reason,
      });
    }
  }

  if (checkManifest) {
    violations.push(...(await manifestViolations(packageRoot)));
  }
  violations.push(...(await cargoManifestViolations(packageRoot, cargoRoots)));
  return violations;
}

export function formatForbiddenImportViolation(violation, packageRoot = defaultPackageRoot) {
  return `${relative(packageRoot, violation.file)}:${violation.line} imports ${JSON.stringify(
    violation.specifier,
  )}: ${violation.reason}`;
}
