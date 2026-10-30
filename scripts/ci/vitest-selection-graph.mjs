import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  "radix-ui", "motion", "@dnd-kit/core", "@dnd-kit/sortable", "@dnd-kit/utilities",
  "i18next", "react-i18next",
]);
const pureBuiltins = new Set(["assert", "assert/strict", "path", "path/posix", "path/win32",
  "url", "util", "util/types", "buffer", "events", "string_decoder", "crypto"]);
// Reviewed setup performs only temporary-home IO and Supertest socket setup,
// not reads of arbitrary repository inputs. Pin contents, not just paths: any
// edit disables this exception until its effects are reviewed again. Continue
// following local imports even for these files; helper changes affect all tests.
const reviewedSetup = new Map([
  ["server/src/__tests__/setup-supertest.ts", {
    hash: "99d7193927468e98b41255ea9a5e37b1a681f02b259c304f3af1a52304eed2bb",
    external: ["supertest/lib/test.js"],
  }],
  ["server/src/__tests__/helpers/isolated-test-home.ts", {
    hash: "bd5645dc590087f26b473beab06d5c3ddd7956a79949f0b3e9713f11897a0c1b",
    external: [],
  }],
]);
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
  const mockBindings = new Set(ast.program.body.filter((node) => node.type === "ImportDeclaration" && node.source.value === "vitest")
    .flatMap((node) => node.specifiers.filter((s) => s.type === "ImportSpecifier" && ["vi", "vitest"].includes(s.imported.name)).map((s) => s.local.name)));
  const hoistedBindings = new Set(ast.program.body.filter((node) => node.type === "ImportDeclaration" && node.source.value === "vitest")
    .flatMap((node) => node.specifiers.filter((s) => s.type === "ImportSpecifier" && ["vi", "vitest"].includes(s.imported.name)
      && s.local.name === s.imported.name).map((s) => s.local.name)));
  const mocks = [];
  if (ast.errors.length) reasons.add("unparsed source");
  const literal = (node) => node?.type === "Literal" && typeof node.value === "string";
  const importSource = (node) => {
    if (literal(node)) imports.add(node.value);
    else reasons.add("dynamic module name");
  };
  for (const statement of ast.program.body) {
    const call = statement.type === "ExpressionStatement" ? statement.expression : null;
    const callee = call?.type === "CallExpression" ? call.callee : null;
    const factory = call?.arguments?.[1];
    if (callee?.type === "MemberExpression" && !callee.computed && callee.property.name === "mock"
      && hoistedBindings.has(callee.object.name) && literal(call.arguments[0])
      && ["ArrowFunctionExpression", "FunctionExpression"].includes(factory?.type) && factory.params.length === 0) {
      mocks.push(call.arguments[0].value);
    }
  }
  function visit(node, parent = null) {
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
    if ((node.type === "Identifier" && node.name === "getBuiltinModule")
      || (literal(node) && node.value === "getBuiltinModule")) reasons.add("dynamic builtin loader");
    if ((node.type === "Identifier" && /^(importActual|unmock|doUnmock|doMock|arguments)$/.test(node.name))
      || (literal(node) && /^(importActual|unmock|doUnmock|doMock)$/.test(node.value))) reasons.add("mock bypass");
    if (node.type === "Identifier" && mockBindings.has(node.name) && parent
      && parent.type !== "ImportSpecifier"
      && !(parent.type === "MemberExpression" && parent.object === node && !parent.computed)) {
      reasons.add("escaped or dynamic mocking API");
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
      const viteGlob = name === "import.meta.glob" && (literal(node.arguments[0])
        || (node.arguments[0]?.type === "ArrayExpression" && node.arguments[0].elements.every(literal)));
      // Vite expands literal globs into dependency edges. New files appear in
      // that expansion; deleted/renamed and non-source inputs force full lanes.
      if (!viteGlob && /\b(?:fetch|eval|Function|glob|globSync)\b/.test(name)) reasons.add("external input or dynamic code");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => visit(child, node));
      else if (value && typeof value === "object" && value.type) visit(value, node);
    }
  }
  visit(ast.program);
  return { imports: [...imports], reasons: [...reasons], mocks };
}

export async function selectProjectTests({ root = process.cwd(), project, changed, onlyOwnChanges = false }) {
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
    const relative = (spec) => path.relative(root, spec.moduleId).split(path.sep).join("/");
    if (onlyOwnChanges && !absoluteChanges.some((file) => file.startsWith(`${owner.config.root}${path.sep}`))) {
      // Keep coarse dependency coverage, but avoid spending a graph traversal
      // on an unchanged consumer project merely to retain most of its IO tests.
      const files = inventory.map(relative).sort();
      return { project, inventory: files, selected: files, related: [], alwaysRun: files, coveredChanges: [],
        opaqueModules: {}, retainedReason: "Unchanged project retains complete lane coverage", seconds: (performance.now() - started) / 1000 };
    }
    const tracked = new Set(execFileSync("git", ["ls-files", "--cached", "-z"], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    }).split("\0").filter(Boolean));
    const audit = new Map();
    const parsed = new Map();
    const parse = (file) => {
      if (!parsed.has(file)) parsed.set(file, sourceDependencies(file, readFileSync(file, "utf8")));
      return parsed.get(file);
    };
    const resolve = async (specifier, importer) => {
      try {
        const resolved = await environment.pluginContainer.resolveId(specifier, importer);
        if (!resolved || resolved.external || !path.isAbsolute(resolved.id) || resolved.id.includes("?")) return null;
        return realpathSync(resolved.id);
      } catch { return null; } // A conditional/require-only export is opaque.
    };
    // Setup dependencies are not test-import edges. A change anywhere in their
    // local import closure invalidates the entire project, including helpers.
    const setup = new Set();
    async function setupClosure(file) {
      if (setup.has(file)) return;
      setup.add(file);
      const source = parse(file);
      const review = reviewedSetup.get(path.relative(root, file).split(path.sep).join("/"));
      const reviewed = review?.hash === createHash("sha256").update(readFileSync(file)).digest("hex");
      if (!reviewed && source.reasons.length) throw new Error(`Opaque setup dependency: ${file}`);
      for (const specifier of source.imports) {
        if (isBuiltin(specifier)) {
          if (!reviewed && !pureBuiltins.has(specifier.replace(/^node:/, ""))) throw new Error(`Opaque setup builtin: ${specifier}`);
          continue;
        }
        if (reviewed && review.external.includes(specifier)) continue;
        const dependency = await resolve(specifier, file);
        if (dependency && inside(root, dependency)) await setupClosure(dependency);
        else if (!dependency) throw new Error(`Unresolved setup dependency: ${specifier}`);
        else if (!purePackages.has(packageName(specifier))) throw new Error(`Opaque setup package: ${specifier}`);
      }
    }
    for (const file of [...(owner.config.setupFiles ?? []), ...(owner.config.globalSetup ?? []),
      ...(owner.config.snapshotSerializers ?? [])]) {
      const resolved = path.isAbsolute(file) ? file : await resolve(file, owner.vite.config.configFile);
      if (resolved && inside(root, resolved)) await setupClosure(resolved);
      else if (!resolved) throw new Error(`Unresolved setup module: ${file}`);
    }
    for (const file of owner.vite.config.configFileDependencies ?? []) setup.add(realpathSync(file));
    const setupChanged = absoluteChanges.some((file) => setup.has(file));
    const raw = await ctx.getRelevantTestSpecifications();
    const modules = environment.moduleGraph.idToModuleMap;
    const resolvedDependencies = new Map();
    const localImports = new Map();
    const dependencyPath = (dep) => {
      if (!resolvedDependencies.has(dep)) {
        const file = dep.startsWith("/@fs/") ? dep.slice(process.platform === "win32" ? 5 : 4)
          : path.join(owner.config.root, dep);
        try { resolvedDependencies.set(dep, realpathSync(file)); }
        catch { resolvedDependencies.set(dep, null); }
      }
      return resolvedDependencies.get(dep);
    };
    for (const [id, module] of modules) {
      if (!inside(root, id) || !/\.[cm]?[jt]sx?$/.test(id)) continue;
      const source = parse(id);
      const reasons = [...source.reasons];
      if (!tracked.has(path.relative(root, id).split(path.sep).join("/"))) reasons.push("generated or untracked source");
      const local = [];
      localImports.set(id, local);
      // Use the same resolved runtime edges as Vitest, including literal dynamic
      // imports. Resolving the original syntax again uses the wrong conditions
      // for require-only exports and invents edges for erased type imports.
      const transformed = module.transformResult;
      if (!Array.isArray(transformed?.deps)) reasons.push("unknown transform shape");
      for (const dependencyId of [...(transformed?.deps ?? []), ...(transformed?.dynamicDeps ?? [])]) {
        if (isBuiltin(dependencyId)) {
          if (!pureBuiltins.has(dependencyId.replace(/^node:/, ""))) reasons.push(`builtin ${dependencyId}`);
          continue;
        }
        const dependency = dependencyPath(dependencyId);
        if (dependency && inside(root, dependency)) {
          local.push(dependency);
          // Vitest intentionally skips some edges (e.g. CJS, externalized
          // workspaces). Never regard an untracked local edge as independent.
          if (!modules.get(dependency)?.transformResult) reasons.push(`untracked dependency ${path.relative(root, dependency)}`);
        } else {
          const external = dependency?.split(`${path.sep}node_modules${path.sep}`).at(-1).split(path.sep).join("/");
          if (!dependency || !dependency.includes(`${path.sep}node_modules${path.sep}`) || !purePackages.has(packageName(external))) {
            reasons.push(`opaque dependency ${external ? packageName(external) : dependencyId}`);
          }
        }
      }
      if (!module.transformResult) reasons.push("untransformed module");
      if (reasons.length) audit.set(id, [...new Set(reasons)]);
    }
    const retained = [];
    for (const spec of inventory) {
      const mocked = new Set();
      // Honor only unconditional, explicitly supplied mock factories without an
      // importOriginal parameter. Automocks, spies, unmock/importActual, dynamic
      // mocking and escaped vi bindings stay conservative. The related-file
      // graph remains uncut: edits to a mocked module can still select its tests.
      if (owner.config.isolate !== false) {
        for (const name of parse(spec.moduleId).mocks) {
          const target = await resolve(name, spec.moduleId);
          if (target && inside(root, target)) mocked.add(target);
        }
      }
      const queue = [spec.moduleId], visited = new Set();
      let opaque = setupChanged || owner.config.isolate === false || !localImports.has(spec.moduleId);
      while (queue.length && !opaque) {
        const file = queue.pop();
        if (visited.has(file)) continue;
        visited.add(file);
        if (audit.has(file)) { opaque = true; break; }
        for (const dependency of localImports.get(file) ?? []) if (!mocked.has(dependency)) queue.push(dependency);
      }
      if (opaque) retained.push(spec);
    }
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
