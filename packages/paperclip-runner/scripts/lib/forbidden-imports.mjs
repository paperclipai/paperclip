import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { SyntaxKind } from "typescript/unstable/ast";

const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".mts", ".cts", ".rs", ".ts", ".tsx"]);
const RUST_IMPORT_PATTERNS = [
  /\b(?:include|include_str|include_bytes)!\s*\(\s*["']([^"']+)["']\s*\)/g,
  /#\[path\s*=\s*["']([^"']+)["']\]/g,
];
const REVIEWED_EVAL_KERNEL = "@paperclipai/paperclip-eval-kernel";
const REVIEWED_EVAL_HARNESS = "src/eval/workflow-harness.ts";

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

/** Parse a whole scan in one compiler session; never execute scanned source. */
export function findSpecifiersInFiles(files) {
  const results = new Map(files.map(({ file }) => [file, []]));
  const javascript = files.filter(({ file }) => extension(file) !== ".rs");
  for (const { file, source } of files.filter(({ file }) => extension(file) === ".rs")) {
    for (const pattern of RUST_IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        results.get(file).push({ specifier: match[1], offset: match.index });
      }
    }
  }
  if (javascript.length === 0) return results;
  const root = "/__paperclip_import_check__";
  const names = javascript.map(({ file }, index) => `input-${index}${extension(file) || ".ts"}`);
  const virtualFiles = Object.fromEntries(javascript.map(({ source }, index) => [`${root}/${names[index]}`, source]));
  virtualFiles[`${root}/tsconfig.json`] = JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, allowJs: true }, files: names,
  });
  const api = new API({ fs: createVirtualFileSystem(virtualFiles) });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [`${root}/tsconfig.json`] });
    const program = snapshot.getProject(`${root}/tsconfig.json`).program;
    for (const [index, { file }] of javascript.entries()) {
      const sourceFile = program.getSourceFile(`${root}/${names[index]}`);
      if (!sourceFile) throw new Error(`Import scanner could not parse ${file}`);
      const found = results.get(file);
      function add(literal) {
        if (literal?.kind === SyntaxKind.StringLiteral || literal?.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
          found.push({ specifier: literal.text, offset: literal.getStart(sourceFile) });
        }
      }
      function visit(node) {
        if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.ExportDeclaration) add(node.moduleSpecifier);
        else if (node.kind === SyntaxKind.ImportEqualsDeclaration && node.moduleReference.kind === SyntaxKind.ExternalModuleReference) add(node.moduleReference.expression);
        else if (node.kind === SyntaxKind.ImportType && node.argument.kind === SyntaxKind.LiteralType) add(node.argument.literal);
        else if (node.kind === SyntaxKind.CallExpression && (
          node.expression.kind === SyntaxKind.ImportKeyword ||
          (node.expression.kind === SyntaxKind.Identifier && node.expression.text === "require")
        )) add(node.arguments[0]);
        node.forEachChild(visit);
      }
      visit(sourceFile);
    }
  } finally {
    api.close();
  }
  return results;
}

export function findSpecifiers(source, file = "source.ts") {
  return findSpecifiersInFiles([{ file, source }]).get(file);
}

function declaredPublicImports(manifest) {
  return new Set(Object.entries(manifest.exports ?? {})
    .filter(([key, target]) => key.startsWith("./") && !key.includes("*") && target !== null)
    .map(([key]) => `@paperclipai/paperclip-runner/${key.slice(2)}`));
}

function publicSourceGraph(packageRoot, manifest, specifiers) {
  const known = new Set(specifiers.keys());
  const sourceCandidates = (path) => {
    const source = path.replace(/\/dist\//, "/src/");
    const stem = source.replace(/(?:\.d)?\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/, "");
    // Follow every matching source candidate conservatively, including barrels
    // and extensionless imports. A public graph must never hide the dev harness.
    return [source, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"]
      .map((suffix) => `${stem}${suffix}`)].filter((candidate) => known.has(candidate));
  };
  const targets = (value) => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(targets) : [];
  const exportSources = (value) => targets(value).flatMap((target) => {
    // Wildcard exports can expose the development harness. Until this gate
    // resolves their full mapping, conservatively treat all sources as public.
    if (target.includes("*")) return [...known];
    return sourceCandidates(resolve(packageRoot, target));
  });
  const queue = exportSources(manifest.exports);
  const reachable = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const { specifier } of specifiers.get(file) ?? []) {
      if (specifier.startsWith(".")) queue.push(...sourceCandidates(resolve(dirname(file), specifier)));
      else if (specifier.startsWith("@paperclipai/paperclip-runner/")) {
        queue.push(...exportSources(manifest.exports?.[`./${specifier.slice("@paperclipai/paperclip-runner/".length)}`]));
      }
    }
  }
  return reachable;
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

function violationReason({ file, packageRoot, specifier, publicRunnerImports, reviewedEvalHarness }) {
  const relativeFile = relative(packageRoot, file).split(/[\\/]/).join("/");
  const isExampleConsumer = relativeFile.startsWith("examples/");
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
    !publicRunnerImports.has(specifier) &&
    !(specifier === REVIEWED_EVAL_KERNEL && reviewedEvalHarness && relativeFile === REVIEWED_EVAL_HARNESS)
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
    (name) => name.startsWith("@paperclipai/") && !(name === REVIEWED_EVAL_KERNEL && manifest.devDependencies[name] === "workspace:*"),
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

  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const sources = await Promise.all(files.sort().map(async (file) => ({ file, source: await readFile(file, "utf8") })));
  const specifiers = findSpecifiersInFiles(sources);
  const publicRunnerImports = declaredPublicImports(manifest);
  const publicSources = publicSourceGraph(packageRoot, manifest, specifiers);
  // ADR0001 permits only this private development harness to use the kernel.
  // A public export reaching it revokes the exception, including through barrels.
  const reviewedEvalHarness = manifest.devDependencies?.[REVIEWED_EVAL_KERNEL] === "workspace:*"
    && !publicSources.has(resolve(packageRoot, REVIEWED_EVAL_HARNESS));
  for (const { file, source } of sources) {
    for (const { specifier, offset } of specifiers.get(file)) {
      const reason = violationReason({ file, packageRoot, specifier, publicRunnerImports, reviewedEvalHarness });
      if (reason === null) continue;
      violations.push({ file, line: source.slice(0, offset).split("\n").length, specifier, reason });
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
