import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { parseSync } from "oxc-parser";
import { createVitest } from "vitest/node";

// Everything else is opaque by default. Do not add IO clients, module loaders,
// filesystem helpers or process launchers here to improve selection counts.
const purePackages = new Set([
  "vitest", "@vitest/expect", "@testing-library/react", "@testing-library/dom",
  "@testing-library/user-event", "@testing-library/jest-dom", "react", "react-dom",
  "react-router", "react-router-dom", "@tanstack/react-query", "@tanstack/query-core",
  "zod", "lodash", "lodash-es", "date-fns", "clsx", "tailwind-merge", "class-variance-authority",
  "lucide-react", "immer", "nanoid", "uuid", "semver",
]);
const pureBuiltins = new Set(["assert", "assert/strict", "path", "path/posix", "path/win32",
  "url", "util", "util/types", "buffer", "events", "string_decoder", "crypto"]);
const packageName = (specifier) => specifier.startsWith("@")
  ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const inside = (root, file) => file.startsWith(`${root}${path.sep}`) && !file.includes(`${path.sep}node_modules${path.sep}`);

// Parse source, including imports erased by mocks/transforms. Unknown loaders
// retain their consumers. This is intentionally conservative, not a regex-based
// promise that arbitrary JavaScript has no effects.
export function sourceDependencies(file, source) {
  const ast = parseSync(file, source);
  const imports = new Set();
  const reasons = new Set();
  if (ast.errors.length) reasons.add("unparsed source");
  const literal = (node) => node?.type === "Literal" && typeof node.value === "string";
  const importSource = (node) => {
    if (literal(node)) imports.add(node.value);
    else reasons.add("dynamic module name");
  };
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if ((node.type === "ImportDeclaration" && node.importKind !== "type")
      || (["ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.exportKind !== "type")) {
      if (node.source) importSource(node.source);
    }
    if (node.type === "ImportExpression") importSource(node.source);
    if (node.type === "TSImportEqualsDeclaration") reasons.add("CommonJS import");
    if (node.type === "Identifier" && /^(require|fetch|eval|Function|WebSocket|XMLHttpRequest|Worker)$/.test(node.name)) {
      reasons.add("external input or dynamic code");
    }
    if (node.type === "CallExpression") {
      const name = source.slice(node.callee.start, node.callee.end);
      if (/^(?:vi|vitest)\.(?:mock|doMock|importActual|importMock)$/.test(name)) {
        importSource(node.arguments[0]);
      }
      if (/\brequire\b/.test(name)) {
        reasons.add("CommonJS loader");
        importSource(node.arguments[0]);
      }
      if (/\b(?:fetch|eval|Function|glob|globSync)\b/.test(name)) reasons.add("external input or dynamic code");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && value.type) visit(value);
    }
  }
  visit(ast.program);
  return { imports: [...imports], reasons: [...reasons] };
}

export async function selectProjectTests({ root = process.cwd(), project, changed }) {
  root = realpathSync(root);
  const started = performance.now();
  const absoluteChanges = changed.map((file) => path.resolve(root, file));
  const ctx = await createVitest({ root, watch: false, project: [project],
    exclude: ["**/dist/**"], reporters: [], related: absoluteChanges });
  try {
    if (ctx.projects.length !== 1 || ctx.projects[0].name !== project) throw new Error(`Unknown project: ${project}`);
    const owner = ctx.projects[0];
    const environment = owner.vite.environments.ssr;
    const inventory = await ctx.globTestSpecifications();
    if (!inventory.length) throw new Error(`Empty inventory: ${project}`);
    const raw = await ctx.getRelevantTestSpecifications();
    const modules = environment.moduleGraph.idToModuleMap;
    const audit = new Map();
    const parsed = new Map();
    const parse = (file) => {
      if (!parsed.has(file)) parsed.set(file, sourceDependencies(file, readFileSync(file, "utf8")));
      return parsed.get(file);
    };
    const resolve = async (specifier, importer) => {
      const resolved = await environment.pluginContainer.resolveId(specifier, importer);
      if (!resolved || resolved.external || !path.isAbsolute(resolved.id) || resolved.id.includes("?")) return null;
      try { return realpathSync(resolved.id); } catch { return null; }
    };
    // Setup dependencies are not test-import edges. A change anywhere in their
    // local import closure invalidates the entire project, including helpers.
    const setup = new Set();
    async function setupClosure(file) {
      if (setup.has(file)) return;
      setup.add(file);
      const source = parse(file);
      if (source.reasons.includes("dynamic module name")) throw new Error(`Dynamic setup dependency: ${file}`);
      for (const specifier of source.imports) {
        if (isBuiltin(specifier)) continue;
        const dependency = await resolve(specifier, file);
        if (dependency && inside(root, dependency)) await setupClosure(dependency);
        else if (specifier.startsWith(".")) throw new Error(`Unresolved setup dependency: ${specifier}`);
      }
    }
    for (const file of owner.config.setupFiles ?? []) await setupClosure(file);
    const setupChanged = absoluteChanges.some((file) => setup.has(file));
    for (const [id, module] of modules) {
      if (!inside(root, id) || !/\.[cm]?[jt]sx?$/.test(id)) continue;
      const source = parse(id);
      const reasons = [...source.reasons];
      for (const specifier of source.imports) {
        if (isBuiltin(specifier)) {
          if (!pureBuiltins.has(specifier.replace(/^node:/, ""))) reasons.push(`builtin ${specifier}`);
          continue;
        }
        const dependency = await resolve(specifier, id);
        if (dependency && inside(root, dependency)) {
          // Vitest intentionally skips some edges (e.g. CJS, externalized
          // workspaces). Never regard an untracked local edge as independent.
          if (!modules.get(dependency)?.transformResult) reasons.push(`untracked dependency ${specifier}`);
        } else if (!dependency || !purePackages.has(packageName(specifier))) {
          reasons.push(`opaque dependency ${specifier}`);
        }
      }
      if (!module.transformResult) reasons.push("untransformed module");
      if (reasons.length) audit.set(id, [...new Set(reasons)]);
    }
    ctx.config.related = [...audit.keys()];
    const retained = setupChanged ? inventory : await ctx.getRelevantTestSpecifications();
    const relative = (spec) => path.relative(root, spec.moduleId).split(path.sep).join("/");
    const selected = [...new Set([...raw, ...retained].map(relative))].sort();
    return {
      project,
      inventory: inventory.map(relative).sort(),
      selected,
      related: raw.map(relative).sort(),
      alwaysRun: retained.map(relative).sort(),
      coveredChanges: changed.filter((file, index) => modules.has(absoluteChanges[index]) || setup.has(absoluteChanges[index])),
      opaqueModules: Object.fromEntries([...audit].map(([file, reasons]) => [path.relative(root, file), reasons])),
      setupChanged,
      seconds: (performance.now() - started) / 1000,
    };
  } finally {
    await ctx.close();
  }
}
