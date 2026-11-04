// Typechecks the server in layers so that no single tsc process holds the whole
// program in memory.
//
// tsc keeps every type it creates until it exits, so its peak grows with the
// source it checks. The server is about 1,700 source files and 500 test files,
// and one program over all of them needs more than 8 GiB at any setting. Most
// of those files are not in an import cycle, so they can be checked separately
// and read back as declarations:
//
//   below  files the largest import cycle depends on, plus unrelated files
//   cycle  the largest import cycle, reading `below` as declarations
//   above  files that depend on the cycle, reading both as declarations
//   tests  test files, reading all three as declarations
//   test-tree-N  src/__tests__, in shards, reading the source layers as declarations
//
// The layers come from the import graph on every run, so nothing has to move
// and no list can go stale. The import scan does not have to be perfect: if it
// misses an edge, a file imports one outside its layer's references and tsc
// fails with TS6307 instead of skipping the file.
//
// server/tsconfig.json stays the single program that editors and `pnpm build`
// use.
//
// Projects outside the server read the source layers as declarations through a
// `tsconfig.layers.json` that references tsconfig.declarations.json in the output
// directory. --declarations-only builds those layers and skips the test layers.
//
// Usage: node scripts/typecheck-layers.mjs [--declarations-only]

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { runTsc } from "../../scripts/run-tsc.mjs";

const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g;
const OUTPUT_DIRECTORY = path.join("node_modules", ".cache", "paperclip-typecheck");
// One program over this tree peaks at 3.9 GiB on one thread. Three peak at 2.5 GiB.
const TEST_TREE_SHARDS = 3;

export const isTestFile = (file) => /\.test\.tsx?$/.test(file) || file.split("/").includes("__tests__");
// tsconfig.json excludes this tree, so the test-tree layers check it.
const isTestTreeFile = (file) => file.startsWith("src/__tests__/");
// Test layers emit nothing, so other projects cannot read them as declarations.
const emitsDeclarations = (layer) => layer.name !== "tests" && !layer.testTree;

export function listSourceFiles(serverRoot) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(path.join(serverRoot, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (/\.tsx?$/.test(entry.name)) files.push(relative);
    }
  };
  walk("src");
  return files.sort();
}

/** Resolves the relative imports of each file. `files` maps a path to its text. */
export function readImports(files) {
  const imports = new Map();
  for (const [file, text] of files) {
    const modules = new Set();
    const json = new Set();
    for (const [, specifier] of text.matchAll(IMPORT_SPECIFIER)) {
      const target = path.posix.join(path.posix.dirname(file), specifier);
      if (target.endsWith(".json")) {
        json.add(target);
        continue;
      }
      const candidates = [
        target,
        target.replace(/\.js$/, ".ts"),
        target.replace(/\.js$/, ".tsx"),
        `${target}.ts`,
        `${target}/index.ts`,
      ];
      const resolved = candidates.find((candidate) => files.has(candidate));
      if (resolved) modules.add(resolved);
    }
    imports.set(file, { modules, json });
  }
  return imports;
}

/** Tarjan's algorithm, iterative because import chains can be very deep. */
function largestCycle(graph) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  let next = 0;
  let largest = [];

  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const work = [{ node: root, edges: [...graph.get(root)], position: 0 }];
    index.set(root, next);
    low.set(root, next);
    next += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.position < frame.edges.length) {
        const edge = frame.edges[frame.position];
        frame.position += 1;
        if (!index.has(edge)) {
          index.set(edge, next);
          low.set(edge, next);
          next += 1;
          stack.push(edge);
          onStack.add(edge);
          work.push({ node: edge, edges: [...graph.get(edge)], position: 0 });
        } else if (onStack.has(edge)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(edge)));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        if (component.length > largest.length) largest = component;
      }
    }
  }
  return largest.length > 1 ? new Set(largest) : new Set();
}

function reachableFrom(start, graph) {
  const seen = new Set(start);
  const pending = [...start];
  while (pending.length > 0) {
    for (const edge of graph.get(pending.pop()) ?? []) {
      if (!seen.has(edge)) {
        seen.add(edge);
        pending.push(edge);
      }
    }
  }
  return seen;
}

/**
 * Sorts every file into the layers, in check order. `files` maps a path to its
 * text. Declaration files are ambient, so every layer lists them.
 */
export function planLayers(files) {
  const declarations = [...files.keys()].filter((file) => file.endsWith(".d.ts"));
  const candidates = new Map([...files].filter(([file]) => !file.endsWith(".d.ts")));
  const imports = readImports(candidates);

  const graph = new Map();
  const reversed = new Map();
  for (const file of candidates.keys()) {
    if (!isTestFile(file)) {
      graph.set(file, new Set());
      reversed.set(file, new Set());
    }
  }
  for (const file of graph.keys()) {
    for (const target of imports.get(file).modules) {
      if (graph.has(target)) {
        graph.get(file).add(target);
        reversed.get(target).add(file);
      }
    }
  }

  const cycle = largestCycle(graph);
  const dependents = reachableFrom(cycle, reversed);
  const above = [...dependents].filter((file) => !cycle.has(file));
  const below = [...graph.keys()].filter((file) => !dependents.has(file));
  const tests = [...candidates.keys()].filter((file) => isTestFile(file) && !isTestTreeFile(file));
  // A hash keeps each file in its shard when other files are added or removed.
  const testTree = Array.from({ length: TEST_TREE_SHARDS }, () => []);
  for (const file of candidates.keys()) {
    if (isTestTreeFile(file)) testTree[crc32(file) % TEST_TREE_SHARDS].push(file);
  }

  const layer = (name, members, references) => {
    const sorted = [...members].sort();
    const json = new Set(sorted.flatMap((file) => [...imports.get(file).json]));
    return { name, sourceFiles: sorted, files: [...sorted, ...[...json].sort(), ...declarations], references };
  };
  return [
    layer("below", below, []),
    layer("cycle", cycle, ["below"]),
    layer("above", above, ["below", "cycle"]),
    layer("tests", tests, ["below", "cycle", "above"]),
    ...testTree.map((shard, index) => ({
      ...layer(`test-tree-${index}`, shard, ["below", "cycle", "above"]),
      testTree: true,
    })),
  ].filter((candidate) => candidate.sourceFiles.length > 0);
}

/** Builds the tsconfig for one layer. Paths are relative to the output directory. */
export function layerConfig(layer, { emptyLayers = new Set() } = {}) {
  const fromOutput = (file) => path.posix.join("../../..", file);
  const references = layer.references
    .filter((name) => !emptyLayers.has(name))
    .map((name) => ({ path: `./tsconfig.${name}.json` }));
  // Editors read the same options from this file.
  if (layer.testTree) {
    return {
      extends: fromOutput("src/__tests__/tsconfig.json"),
      files: layer.files.map(fromOutput),
      include: [],
      references,
    };
  }
  const output =
    layer.name === "tests"
      ? { composite: false, declaration: false, declarationMap: false, sourceMap: false, noEmit: true }
      : {
          composite: true,
          declaration: true,
          declarationMap: false,
          sourceMap: false,
          emitDeclarationOnly: true,
          outDir: "./dts",
          tsBuildInfoFile: `./${layer.name}.tsbuildinfo`,
        };
  return {
    extends: fromOutput("tsconfig.json"),
    compilerOptions: { ...output, rootDir: fromOutput("src") },
    files: layer.files.map(fromOutput),
    include: [],
    references,
  };
}

/** Builds the config other projects reference to read the source layers as declarations. */
export function declarationsConfig(layers) {
  return {
    compilerOptions: { composite: true },
    files: [],
    references: layers
      .filter(emitsDeclarations)
      .map((layer) => ({ path: `./tsconfig.${layer.name}.json` })),
  };
}

export function typecheckLayers({
  serverRoot,
  declarationsOnly = false,
  run = runTsc,
  log = console.log,
}) {
  const sourceFiles = listSourceFiles(serverRoot);
  const layers = planLayers(
    new Map(sourceFiles.map((file) => [file, readFileSync(path.join(serverRoot, file), "utf8")])),
  );
  const planned = new Set(layers.map((layer) => layer.name));
  const emptyLayers = new Set(["below", "cycle", "above", "tests"].filter((name) => !planned.has(name)));

  const outputRoot = path.join(serverRoot, OUTPUT_DIRECTORY);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  // Without this, the path under node_modules would make the declarations CommonJS.
  writeFileSync(path.join(outputRoot, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  for (const layer of layers) {
    writeFileSync(
      path.join(outputRoot, `tsconfig.${layer.name}.json`),
      `${JSON.stringify(layerConfig(layer, { emptyLayers }), null, 2)}\n`,
    );
  }

  writeFileSync(
    path.join(outputRoot, "tsconfig.declarations.json"),
    `${JSON.stringify(declarationsConfig(layers), null, 2)}\n`,
  );

  let exitCode = 0;
  for (const layer of layers) {
    if (declarationsOnly && !emitsDeclarations(layer)) continue;
    log(`typecheck:layers: ${layer.name} (${layer.sourceFiles.length} files)`);
    const config = path.join(OUTPUT_DIRECTORY, `tsconfig.${layer.name}.json`);
    const { status, signal } = run(["-p", config], { cwd: serverRoot });
    // A killed process leaves no declarations, so later layers would only add noise.
    if (signal) return status || 1;
    // Later layers still run after type errors. Each file is checked in one
    // layer, so this reports everything a single tsc run would.
    if (status !== 0) exitCode = status;
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = typecheckLayers({
    serverRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    declarationsOnly: process.argv.includes("--declarations-only"),
  });
}
