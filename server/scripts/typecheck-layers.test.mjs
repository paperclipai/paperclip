import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { emitOnlyTscArgs, lowMemoryTscArgs, runTsc } from "../../scripts/run-tsc.mjs";
import { STEPS, typecheckLowMemory } from "../../scripts/typecheck-low-memory.mjs";
import { findServerSource, PREPARE_STEPS, PROJECTS, typecheckTestProjects } from "../../scripts/typecheck-test-projects.mjs";
import { declarationsConfig, layerConfig, listSourceFiles, planLayers, readImports, typecheckLayers } from "./typecheck-layers.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcesOf = (layers, name) => layers.find((layer) => layer.name === name)?.sourceFiles;

describe("readImports", () => {
  it("resolves every import form that TypeScript follows", () => {
    const files = new Map([
      [
        "src/a.ts",
        [
          `import { b } from "./b.js";`,
          `export * from "./c.js";`,
          `import "./d.js";`,
          `const e = await import("./e.js");`,
          `type F = typeof import("./f.js");`,
          `import g from "./g/index.js";`,
          `import h from "./h.js";`,
          `import data from "./data.json" with { type: "json" };`,
          `import { z } from "zod";`,
        ].join("\n"),
      ],
      ["src/b.ts", ""],
      ["src/c.ts", ""],
      ["src/d.ts", ""],
      ["src/e.ts", ""],
      ["src/f.ts", ""],
      ["src/g/index.ts", ""],
      ["src/h.tsx", ""],
    ]);

    const { modules, json } = readImports(files).get("src/a.ts");

    expect([...modules].sort()).toEqual([
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "src/f.ts",
      "src/g/index.ts",
      "src/h.tsx",
    ]);
    expect([...json]).toEqual(["src/data.json"]);
  });
});

describe("planLayers", () => {
  it("separates the largest cycle from what it depends on and what depends on it", () => {
    const layers = planLayers(
      new Map([
        ["src/leaf.ts", ""],
        ["src/unrelated.ts", ""],
        ["src/one.ts", `import "./two.js"; import "./leaf.js";`],
        ["src/two.ts", `import "./one.js";`],
        ["src/route.ts", `import "./one.js";`],
        ["src/route.test.ts", `import "./route.js";`],
        ["src/types/ambient.d.ts", ""],
      ]),
    );

    expect(sourcesOf(layers, "below")).toEqual(["src/leaf.ts", "src/unrelated.ts"]);
    expect(sourcesOf(layers, "cycle")).toEqual(["src/one.ts", "src/two.ts"]);
    expect(sourcesOf(layers, "above")).toEqual(["src/route.ts"]);
    expect(sourcesOf(layers, "tests")).toEqual(["src/route.test.ts"]);
    for (const layer of layers) expect(layer.files).toContain("src/types/ambient.d.ts");
  });

  it("keeps test support files in the test layer and shards src/__tests__ by a stable hash", () => {
    const layers = planLayers(
      new Map([
        ["src/a.ts", ""],
        ["src/services/__tests__/fixtures.ts", ""],
        ["src/__tests__/helpers/db.ts", ""],
        ["src/__tests__/big.test.ts", ""],
      ]),
    );

    expect(sourcesOf(layers, "below")).toEqual(["src/a.ts"]);
    expect(sourcesOf(layers, "tests")).toEqual(["src/services/__tests__/fixtures.ts"]);
    const shards = layers.filter((layer) => layer.testTree);
    expect(shards.flatMap((layer) => layer.sourceFiles).sort()).toEqual([
      "src/__tests__/big.test.ts",
      "src/__tests__/helpers/db.ts",
    ]);
    for (const shard of shards) expect(shard.references).toEqual(["below", "cycle", "above"]);

    const withMore = planLayers(
      new Map([
        ["src/a.ts", ""],
        ["src/__tests__/helpers/db.ts", ""],
        ["src/__tests__/big.test.ts", ""],
        ["src/__tests__/added-1.test.ts", ""],
        ["src/__tests__/added-2.test.ts", ""],
      ]),
    );
    for (const shard of shards) {
      for (const file of shard.sourceFiles) expect(sourcesOf(withMore, shard.name)).toContain(file);
    }
  });

  it("lists imported JSON in the layer that imports it", () => {
    const layers = planLayers(
      new Map([
        ["src/a.ts", `import data from "./data.json";`],
        ["src/one.ts", `import "./two.js"; import data from "./cycle.json";`],
        ["src/two.ts", `import "./one.js";`],
      ]),
    );

    expect(layers.find((layer) => layer.name === "below").files).toContain("src/data.json");
    expect(layers.find((layer) => layer.name === "cycle").files).toContain("src/cycle.json");
  });

  it("omits layers with no files, as when the source has no cycle", () => {
    const layers = planLayers(new Map([["src/a.ts", ""], ["src/b.ts", `import "./a.js";`]]));

    expect(layers.map((layer) => layer.name)).toEqual(["below"]);
    expect(sourcesOf(layers, "below")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("covers the real server: one layer per file, and no import reaches a later layer", () => {
    const sourceFiles = listSourceFiles(serverRoot);
    const files = new Map(
      sourceFiles.map((file) => [file, readFileSync(path.join(serverRoot, file), "utf8")]),
    );
    const layers = planLayers(files);

    const planned = layers.flatMap((layer) => layer.sourceFiles);
    expect(new Set(planned).size).toBe(planned.length);
    expect(planned.sort()).toEqual(
      sourceFiles.filter((file) => !file.endsWith(".d.ts")).sort(),
    );

    const position = new Map(
      layers.flatMap((layer, index) => layer.sourceFiles.map((file) => [file, index])),
    );
    const imports = readImports(new Map([...files].filter(([file]) => !file.endsWith(".d.ts"))));
    for (const layer of layers.filter((candidate) => candidate.name !== "tests" && !candidate.testTree)) {
      for (const file of layer.sourceFiles) {
        for (const target of imports.get(file).modules) {
          if (position.has(target)) expect(position.get(target)).toBeLessThanOrEqual(position.get(file));
        }
      }
    }
  });
});

describe("layerConfig", () => {
  const layer = { name: "cycle", files: ["src/a.ts"], references: ["below"] };

  it("emits declarations for source layers and references earlier ones", () => {
    const config = layerConfig(layer);

    expect(config.compilerOptions).toMatchObject({ composite: true, emitDeclarationOnly: true, outDir: "./dts" });
    expect(config.extends).toBe("../../../tsconfig.json");
    expect(config.files).toEqual(["../../../src/a.ts"]);
    expect(config.references).toEqual([{ path: "./tsconfig.below.json" }]);
  });

  it("emits nothing for tests and drops references to empty layers", () => {
    const config = layerConfig(
      { name: "tests", files: [], references: ["below", "cycle"] },
      { emptyLayers: new Set(["cycle"]) },
    );

    expect(config.compilerOptions).toMatchObject({ composite: false, noEmit: true });
    expect(config.references).toEqual([{ path: "./tsconfig.below.json" }]);
  });
});

describe("layerConfig for the test tree", () => {
  it("reads the options that editors read and emits nothing", () => {
    const config = layerConfig({
      name: "test-tree-0",
      files: ["src/__tests__/a.test.ts"],
      references: ["below"],
      testTree: true,
    });

    expect(config.extends).toBe("../../../src/__tests__/tsconfig.json");
    expect(config.compilerOptions).toBeUndefined();
    expect(config.files).toEqual(["../../../src/__tests__/a.test.ts"]);
    expect(config.references).toEqual([{ path: "./tsconfig.below.json" }]);
  });

  it("has a real tests tsconfig that cannot emit and sees the ambient types", () => {
    const config = JSON.parse(readFileSync(path.join(serverRoot, "src/__tests__/tsconfig.json"), "utf8"));

    expect(config.compilerOptions).toMatchObject({ noEmit: true, rootDir: "../../.." });
    expect(config.include).toContain("../types/*.d.ts");
  });
});

describe("declarationsConfig", () => {
  it("references the source layers that exist, and no test layer", () => {
    const config = declarationsConfig([
      { name: "below" },
      { name: "above" },
      { name: "tests" },
      { name: "test-tree-0", testTree: true },
    ]);

    expect(config.compilerOptions.composite).toBe(true);
    expect(config.files).toEqual([]);
    expect(config.references).toEqual([{ path: "./tsconfig.below.json" }, { path: "./tsconfig.above.json" }]);
  });
});

describe("typecheckLayers", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function serverFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "typecheck-layers-"));
    roots.push(root);
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "leaf.ts"), "");
    writeFileSync(path.join(root, "src", "one.ts"), `import "./two.js"; import "./leaf.js";`);
    writeFileSync(path.join(root, "src", "two.ts"), `import "./one.js";`);
    writeFileSync(path.join(root, "src", "route.ts"), `import "./one.js";`);
    writeFileSync(path.join(root, "src", "route.test.ts"), `import "./route.js";`);
    return root;
  }

  it("runs the layers in order and marks the output directory as ESM", () => {
    const root = serverFixture();
    const configs = [];

    const status = typecheckLayers({
      serverRoot: root,
      log: () => {},
      run: (args) => {
        configs.push(path.basename(args[1]));
        return { status: 0, signal: null };
      },
    });

    expect(status).toBe(0);
    expect(configs).toEqual([
      "tsconfig.below.json",
      "tsconfig.cycle.json",
      "tsconfig.above.json",
      "tsconfig.tests.json",
    ]);
    const output = path.join(root, "node_modules", ".cache", "paperclip-typecheck");
    expect(JSON.parse(readFileSync(path.join(output, "package.json"), "utf8"))).toEqual({ type: "module" });
  });

  it("skips the test layers when only declarations are needed", () => {
    const root = serverFixture();
    mkdirSync(path.join(root, "src", "__tests__"));
    writeFileSync(path.join(root, "src", "__tests__", "route.test.ts"), `import "../route.js";`);
    const configs = [];

    const status = typecheckLayers({
      serverRoot: root,
      declarationsOnly: true,
      log: () => {},
      run: (args) => {
        configs.push(path.basename(args[1]));
        return { status: 0, signal: null };
      },
    });

    expect(status).toBe(0);
    expect(configs).toEqual(["tsconfig.below.json", "tsconfig.cycle.json", "tsconfig.above.json"]);
    const output = path.join(root, "node_modules", ".cache", "paperclip-typecheck");
    expect(JSON.parse(readFileSync(path.join(output, "tsconfig.declarations.json"), "utf8")).references).toEqual([
      { path: "./tsconfig.below.json" },
      { path: "./tsconfig.cycle.json" },
      { path: "./tsconfig.above.json" },
    ]);
  });

  it("reports type errors from every layer", () => {
    const root = serverFixture();
    const configs = [];

    const status = typecheckLayers({
      serverRoot: root,
      log: () => {},
      run: (args) => {
        configs.push(args[1]);
        return { status: configs.length === 1 ? 2 : 0, signal: null };
      },
    });

    expect(status).toBe(2);
    expect(configs).toHaveLength(4);
  });

  it("stops when a process is killed, because later layers have no declarations", () => {
    const root = serverFixture();
    const configs = [];

    const status = typecheckLayers({
      serverRoot: root,
      log: () => {},
      run: (args) => {
        configs.push(args[1]);
        return { status: 1, signal: "SIGKILL" };
      },
    });

    expect(status).toBe(1);
    expect(configs).toHaveLength(1);
  });
});

describe("typecheckLayers with the real compiler", () => {
  const tsc = path.join(serverRoot, "node_modules", "typescript", "bin", "tsc");
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function compilerFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "typecheck-layers-real-"));
    roots.push(root);
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    writeFileSync(
      path.join(root, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          types: [],
          outDir: "dist",
          rootDir: "src",
          resolveJsonModule: true,
          skipLibCheck: true,
        },
        include: ["src"],
      })}\n`,
    );
    const sources = {
      "leaf.ts": `export const leaf = 1;\n`,
      "one.ts": `import { two } from "./two.js";\nimport { leaf } from "./leaf.js";\nexport const one = () => leaf + two();\n`,
      "two.ts": `import { one } from "./one.js";\nexport const two = (): number => one.length;\n`,
      "route.ts": `import { one } from "./one.js";\nexport const route = () => one();\n`,
      "route.test.ts": `import { route } from "./route.js";\nexport const checked: number = route();\n`,
    };
    for (const [name, text] of Object.entries(sources)) {
      writeFileSync(path.join(root, "src", name), text);
    }
    return root;
  }

  function check(root) {
    const output = [];
    const status = typecheckLayers({
      serverRoot: root,
      log: () => {},
      run: (args, { cwd }) => {
        const result = spawnSync(process.execPath, [tsc, ...args], { cwd, encoding: "utf8" });
        output.push(result.stdout, result.stderr);
        return { status: result.status ?? 1, signal: result.signal };
      },
    });
    return { status, output: output.join("") };
  }

  it("emits declarations between layers and checks every layer", () => {
    const root = compilerFixture();

    const { status, output } = check(root);

    expect(output).toBe("");
    expect(status).toBe(0);
    const declarations = path.join(root, "node_modules", ".cache", "paperclip-typecheck", "dts");
    for (const name of ["leaf.d.ts", "one.d.ts", "two.d.ts", "route.d.ts"]) {
      expect(existsSync(path.join(declarations, name))).toBe(true);
    }
    expect(existsSync(path.join(declarations, "route.test.d.ts"))).toBe(false);
  }, 60_000);

  it("lets a project outside the server read the source layers as declarations", () => {
    const root = compilerFixture();
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "use.ts"), `import { route } from "../src/route.js";\nexport const used: number = route();\n`);
    const config = path.join(outside, "tsconfig.layers.json");
    writeFileSync(
      config,
      `${JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { noEmit: true, rootDir: "..", outDir: null },
        include: ["*.ts"],
        references: [{ path: "../node_modules/.cache/paperclip-typecheck/tsconfig.declarations.json" }],
      })}\n`,
    );
    const buildDeclarations = () =>
      typecheckLayers({
        serverRoot: root,
        declarationsOnly: true,
        log: () => {},
        run: (args, { cwd }) => {
          const result = spawnSync(process.execPath, [tsc, ...args], { cwd, encoding: "utf8" });
          return { status: result.status ?? 1, signal: result.signal };
        },
      });
    const tscOutside = (...args) => spawnSync(process.execPath, [tsc, "-p", config, ...args], { cwd: root, encoding: "utf8" });

    expect(buildDeclarations()).toBe(0);
    const passing = tscOutside();
    expect(passing.stdout).toBe("");
    expect(passing.status).toBe(0);
    const loaded = tscOutside("--listFilesOnly").stdout;
    expect(loaded).toContain("paperclip-typecheck/dts/route.d.ts");
    expect(loaded).not.toContain("src/route.ts");
    expect(findServerSource(loaded.split("\n").filter(Boolean), root)).toEqual([]);

    const layered = readFileSync(config, "utf8");
    const { references: _references, ...withoutReferences } = JSON.parse(layered);
    writeFileSync(config, `${JSON.stringify(withoutReferences)}\n`);
    const allSource = tscOutside("--listFilesOnly").stdout.split("\n").filter(Boolean);
    expect(findServerSource(allSource, root)).toContain("src/route.ts");
    writeFileSync(config, layered);

    writeFileSync(path.join(root, "src", "route.ts"), `import { one } from "./one.js";\nexport const route = () => String(one());\n`);
    expect(buildDeclarations()).toBe(0);
    const failing = tscOutside();
    expect(failing.stdout).toContain("outside/use.ts");
    expect(failing.stdout).toContain("TS2322");
    expect(failing.status).not.toBe(0);
  }, 60_000);

  it("reports a changed export in the layers that depend on it", () => {
    const root = compilerFixture();
    writeFileSync(path.join(root, "src", "leaf.ts"), `export const renamedLeaf = 1;\n`);

    const { status, output } = check(root);

    expect(status).not.toBe(0);
    expect(output).toMatch(/src\/one\.ts\(\d+,\d+\): error TS\d+/);
    expect(output).toContain("leaf");
  }, 60_000);

  function addTestTree(root, source) {
    mkdirSync(path.join(root, "src", "__tests__"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "__tests__", "tsconfig.json"),
      `${JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { noEmit: true, rootDir: "../.." },
        include: ["."],
      })}\n`,
    );
    writeFileSync(path.join(root, "src", "__tests__", "tree.test.ts"), source);
  }

  it("checks the test tree through declarations", () => {
    const root = compilerFixture();
    addTestTree(root, `import { route } from "../route.js";\nexport const checked: number = route();\n`);

    const { status, output } = check(root);

    expect(output).toBe("");
    expect(status).toBe(0);
  }, 60_000);

  it("fails on a type error in the test tree", () => {
    const root = compilerFixture();
    addTestTree(root, `import { route } from "../route.js";\nexport const checked: string = route();\n`);

    const { status, output } = check(root);

    expect(status).not.toBe(0);
    expect(output).toMatch(/tree\.test\.ts\(2,\d+\): error TS2322/);
  }, 60_000);

  it("fails when the test-tree tsconfig is invalid", () => {
    const root = compilerFixture();
    addTestTree(root, `export const checked = 1;\n`);
    writeFileSync(
      path.join(root, "src", "__tests__", "tsconfig.json"),
      `${JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { noEmit: true, rootDir: "../..", target: "not-a-target" } })}\n`,
    );

    const { status, output } = check(root);

    expect(status).not.toBe(0);
    expect(output).toMatch(/error TS\d+/);
  }, 60_000);

  it("reports a type change through declarations in the test layer", () => {
    const root = compilerFixture();
    writeFileSync(
      path.join(root, "src", "route.ts"),
      `import { one } from "./one.js";\nexport const route = (): string => String(one());\n`,
    );

    const { status, output } = check(root);

    expect(status).not.toBe(0);
    expect(output).toMatch(/src\/route\.test\.ts\(\d+,\d+\): error TS2322/);
  }, 60_000);

  // Emitted declarations keep imports of .d.mts and JSON files, which tsc does not
  // copy to the output directory. If those imports stopped resolving, skipLibCheck
  // would hide it and the types would become `any`, so these errors would disappear.
  it("keeps types from .d.mts and JSON imports in later layers", () => {
    const root = compilerFixture();
    mkdirSync(path.join(root, "src", "scripts"));
    writeFileSync(path.join(root, "src", "scripts", "helper.mjs"), `export {};\n`);
    writeFileSync(path.join(root, "src", "scripts", "helper.d.mts"), `export interface Manifest { version: number }\n`);
    writeFileSync(path.join(root, "src", "catalog.json"), `${JSON.stringify({ tools: [{ name: "a" }] })}\n`);
    writeFileSync(
      path.join(root, "src", "leaf.ts"),
      [
        `import catalog from "./catalog.json" with { type: "json" };`,
        `import type { Manifest } from "./scripts/helper.mjs";`,
        `export type { Manifest };`,
        `export type Tool = (typeof catalog.tools)[number];`,
        `export const leaf = 1;`,
        ``,
      ].join("\n"),
    );
    const misuse = [
      `import type { Manifest, Tool } from "./leaf.js";`,
      `export const manifest: Manifest = { wrong: 1 };`,
      `export const tool: Tool = { wrong: 1 };`,
      ``,
    ].join("\n");
    writeFileSync(path.join(root, "src", "cycle-misuse.ts"), `import { one } from "./one.js";\nexport const used = one;\n${misuse}`);
    writeFileSync(
      path.join(root, "src", "two.ts"),
      `import { one } from "./one.js";\nimport { used } from "./cycle-misuse.js";\nexport const two = (): number => one.length + used.length;\n`,
    );
    writeFileSync(path.join(root, "src", "misuse.test.ts"), misuse);

    const { status, output } = check(root);

    expect(status).not.toBe(0);
    for (const file of ["cycle-misuse", "misuse\\.test"]) {
      expect(output).toMatch(new RegExp(`src/${file}\\.ts\\(\\d+,\\d+\\): error TS2353.*'Manifest'`));
      expect(output).toMatch(new RegExp(`src/${file}\\.ts\\(\\d+,\\d+\\): error TS2353.*'\\{ name: string; \\}'`));
    }
  }, 60_000);
});

describe("typecheckLowMemory", () => {
  it("runs every step in low-memory mode and stops at a failure", () => {
    const calls = [];
    const run = (args, { env }) => {
      calls.push([args, env.PAPERCLIP_TYPECHECK_LOW_MEMORY]);
      return calls.length === 1 ? 0 : 3;
    };

    expect(typecheckLowMemory({ cwd: serverRoot, env: {}, run })).toBe(3);
    expect(calls).toEqual(STEPS.map((args) => [args, "1"]));
  });

  it("does not run the typecheck after a failed preflight", () => {
    const calls = [];

    const status = typecheckLowMemory({
      cwd: serverRoot,
      env: {},
      run: (args) => {
        calls.push(args);
        return 1;
      },
    });

    expect(status).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("typecheckTestProjects", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function repositoryFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "typecheck-test-projects-"));
    roots.push(root);
    mkdirSync(path.join(root, "server", "src"), { recursive: true });
    writeFileSync(path.join(root, "server", "src", "leaf.ts"), "");
    writeFileSync(path.join(root, "server", "src", "one.ts"), `import "./two.js"; import "./leaf.js";`);
    writeFileSync(path.join(root, "server", "src", "two.ts"), `import "./one.js";`);
    writeFileSync(path.join(root, "server", "src", "route.ts"), `import "./one.js";`);
    writeFileSync(path.join(root, "server", "src", "route.test.ts"), `import "./route.js";`);
    return root;
  }

  function runWith(
    root,
    {
      pnpmStatus = () => 0,
      tscResult = () => ({ status: 0, signal: null }),
      listFiles = () => ({ status: 0, files: [] }),
      ...options
    } = {},
  ) {
    const calls = [];
    const errors = [];
    const status = typecheckTestProjects({
      root,
      listFiles,
      log: () => {},
      logError: (message) => errors.push(message),
      pnpm: (args, { env }) => {
        calls.push({ tool: "pnpm", args, env });
        return pnpmStatus(args);
      },
      run: (args, { env }) => {
        const target = path.basename(path.dirname(args[1])) === "paperclip-typecheck" ? path.basename(args[1]) : args[1];
        calls.push({ tool: "tsc", target, env });
        return tscResult(target);
      },
      ...options,
    });
    return { status, calls, errors };
  }

  it("prepares, builds declarations without the tests layer, and then checks the projects", () => {
    const env = { MARKER: "1" };

    const { status, calls } = runWith(repositoryFixture(), { projects: ["tests/a", "tests/b"], env });

    expect(status).toBe(0);
    expect(calls.filter((call) => call.tool === "pnpm").map((call) => call.args)).toEqual(PREPARE_STEPS);
    expect(calls.filter((call) => call.tool === "tsc").map((call) => call.target)).toEqual([
      "tsconfig.below.json",
      "tsconfig.cycle.json",
      "tsconfig.above.json",
      "tests/a/tsconfig.layers.json",
      "tests/b/tsconfig.layers.json",
    ]);
    expect(calls.every((call) => call.env === env)).toBe(true);
  });

  it("stops when the preparation or the server layers fail", () => {
    const prepare = runWith(repositoryFixture(), { pnpmStatus: () => 3 });
    expect(prepare.status).toBe(3);
    expect(prepare.calls).toHaveLength(1);

    const layers = runWith(repositoryFixture(), {
      projects: ["tests/a"],
      tscResult: (target) => ({ status: target === "tsconfig.cycle.json" ? 2 : 0, signal: null }),
    });
    expect(layers.status).toBe(2);
    expect(layers.calls.some((call) => call.target === "tests/a/tsconfig.layers.json")).toBe(false);
  });

  it("checks every project after a type error, and stops when a process is killed", () => {
    const errors = runWith(repositoryFixture(), {
      projects: ["tests/a", "tests/b"],
      tscResult: (target) => ({ status: target === "tests/a/tsconfig.layers.json" ? 2 : 0, signal: null }),
    });
    expect(errors.status).toBe(2);
    expect(errors.calls.at(-1).target).toBe("tests/b/tsconfig.layers.json");

    const killed = runWith(repositoryFixture(), {
      projects: ["tests/a", "tests/b"],
      tscResult: (target) =>
        target === "tests/a/tsconfig.layers.json" ? { status: 1, signal: "SIGKILL" } : { status: 0, signal: null },
    });
    expect(killed.status).toBe(1);
    expect(killed.calls.at(-1).target).toBe("tests/a/tsconfig.layers.json");
  });

  it("reuses declarations without preparing or building layers", () => {
    const { status, calls } = runWith(repositoryFixture(), { projects: ["tests/a"], reuseDeclarations: true });

    expect(status).toBe(0);
    expect(calls.map((call) => call.target ?? call.tool)).toEqual(["tests/a/tsconfig.layers.json"]);
  });

  it("fails when a project loads server source, even if its types pass", () => {
    const root = repositoryFixture();
    const server = path.join(root, "server");

    const { status, errors } = runWith(root, {
      projects: ["tests/a", "tests/b"],
      reuseDeclarations: true,
      listFiles: (config) => ({
        status: 0,
        files: config.startsWith("tests/a/") ? [path.join(server, "src", "route.ts")] : [],
      }),
    });

    expect(status).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tests/a loads 1 server source files");
    expect(errors[0]).toContain("src/route.ts");
  });

  it("fails when a project's files cannot be listed, and keeps a type error's status", () => {
    const listing = runWith(repositoryFixture(), {
      projects: ["tests/a"],
      reuseDeclarations: true,
      listFiles: () => ({ status: 3, files: [], output: "TS6053" }),
    });
    expect(listing.status).toBe(3);
    expect(listing.errors[0]).toContain("TS6053");

    const both = runWith(repositoryFixture(), {
      projects: ["tests/a"],
      reuseDeclarations: true,
      tscResult: () => ({ status: 2, signal: null }),
      listFiles: () => ({ status: 3, files: [], output: "" }),
    });
    expect(both.status).toBe(2);
  });

  it("counts only source files that a layer should provide", () => {
    const server = path.join(path.sep, "repo", "server");
    const file = (relative) => path.join(server, ...relative.split("/"));

    expect(
      findServerSource(
        [
          file("src/route.ts"),
          file("src/view.tsx"),
          file("src/legacy.js"),
          file("src/types/express.d.ts"),
          file("src/data.json"),
          file("src/route.test.ts"),
          file("src/__tests__/helpers/home.ts"),
          file("node_modules/.cache/paperclip-typecheck/dts/route.d.ts"),
          file("test-baselines/lifecycle.test.ts"),
          path.join(path.sep, "repo", "tests", "a.ts"),
        ],
        server,
      ),
    ).toEqual(["src/route.ts", "src/view.tsx", "src/legacy.js"]);
  });

  it("covers every project under tests/, or names why it does not", () => {
    // This project imports one small server file, so it stays one small program.
    const singlePrograms = ["tests/runner-acceptance"];
    const testsRoot = path.join(serverRoot, "..", "tests");
    const projects = readdirSync(testsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(testsRoot, entry.name, "tsconfig.json")))
      .map((entry) => `tests/${entry.name}`);

    expect(projects.sort()).toEqual(
      [...PROJECTS.filter((project) => project.startsWith("tests/")), ...singlePrograms].sort(),
    );
  });

  it("prepares the same way as the server typecheck", () => {
    const { scripts } = JSON.parse(readFileSync(path.join(serverRoot, "package.json"), "utf8"));
    for (const step of PREPARE_STEPS) {
      expect(scripts.typecheck).toContain(`pnpm ${step.join(" ")}`);
    }
  });

  it.each(PROJECTS)("keeps the generated references out of the tsconfig.json of %s", (project) => {
    const directory = path.join(serverRoot, "..", project);
    const readConfig = (name) => JSON.parse(readFileSync(path.join(directory, name), "utf8"));

    // Vitest reads tsconfig.json and fails when a referenced config does not exist yet.
    expect(readConfig("tsconfig.json").references).toBeUndefined();
    const layered = readConfig("tsconfig.layers.json");
    expect(layered.extends).toBe("./tsconfig.json");
    expect(layered.references.map((reference) => path.resolve(directory, reference.path))).toEqual([
      path.join(serverRoot, "node_modules", ".cache", "paperclip-typecheck", "tsconfig.declarations.json"),
    ]);
  });
});

describe("runTsc", () => {
  it("emits JavaScript without checks or declarations in emit-only mode", () => {
    const root = mkdtempSync(path.join(tmpdir(), "run-tsc-emit-only-"));
    try {
      mkdirSync(path.join(root, "src"));
      mkdirSync(path.join(root, "node_modules"));
      symlinkSync(
        realpathSync(path.join(serverRoot, "node_modules", "typescript")),
        path.join(root, "node_modules", "typescript"),
      );
      writeFileSync(
        path.join(root, "tsconfig.json"),
        `${JSON.stringify({
          compilerOptions: { declaration: true, declarationMap: true, types: [], outDir: "dist", rootDir: "src" },
          include: ["src"],
        })}\n`,
      );
      writeFileSync(path.join(root, "src", "a.ts"), `export const value: number = "not a number";\n`);

      const { status } = runTsc([], { cwd: root, env: { ...process.env, PAPERCLIP_TSC_EMIT_ONLY: "1" } });

      expect(status).toBe(0);
      expect(existsSync(path.join(root, "dist", "a.js"))).toBe(true);
      expect(existsSync(path.join(root, "dist", "a.d.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("accepts build mode with low-memory mode on", () => {
    const { status } = runTsc(["-b", "--dry"], {
      cwd: serverRoot,
      env: { ...process.env, PAPERCLIP_TYPECHECK_LOW_MEMORY: "1" },
    });

    expect(status).toBe(0);
  });
});

describe("emitOnlyTscArgs", () => {
  it("removes checks and declarations only in emit-only mode", () => {
    expect(emitOnlyTscArgs({ PAPERCLIP_TSC_EMIT_ONLY: "1" })).toEqual([
      "--noCheck",
      "--declaration",
      "false",
      "--declarationMap",
      "false",
    ]);
    expect(emitOnlyTscArgs({})).toEqual([]);
  });

  it("is what the Dockerfile selects for the server build", () => {
    const dockerfile = readFileSync(path.join(serverRoot, "..", "Dockerfile"), "utf8");

    expect(dockerfile).toContain("RUN PAPERCLIP_TSC_EMIT_ONLY=1 pnpm --filter @paperclipai/server build\n");
  });
});

describe("lowMemoryTscArgs", () => {
  it("uses one thread only when low-memory mode is on", () => {
    expect(lowMemoryTscArgs({ PAPERCLIP_TYPECHECK_LOW_MEMORY: "1" })).toEqual(["--singleThreaded"]);
    expect(lowMemoryTscArgs({ PAPERCLIP_TYPECHECK_LOW_MEMORY: "0" })).toEqual([]);
    expect(lowMemoryTscArgs({})).toEqual([]);
  });
});
