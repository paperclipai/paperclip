import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { emitOnlyTscArgs, lowMemoryTscArgs, runTsc } from "../../scripts/run-tsc.mjs";
import { STEPS, typecheckLowMemory } from "../../scripts/typecheck-low-memory.mjs";
import { layerConfig, listSourceFiles, planLayers, readImports, typecheckLayers } from "./typecheck-layers.mjs";

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

  it("keeps test support files in the test layer and leaves src/__tests__ to imports", () => {
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
      sourceFiles.filter((file) => !file.endsWith(".d.ts") && !file.startsWith("src/__tests__/")).sort(),
    );

    const position = new Map(
      layers.flatMap((layer, index) => layer.sourceFiles.map((file) => [file, index])),
    );
    const imports = readImports(new Map([...files].filter(([file]) => !file.endsWith(".d.ts"))));
    for (const layer of layers.filter((candidate) => candidate.name !== "tests")) {
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

  it("reports a changed export in the layers that depend on it", () => {
    const root = compilerFixture();
    writeFileSync(path.join(root, "src", "leaf.ts"), `export const renamedLeaf = 1;\n`);

    const { status, output } = check(root);

    expect(status).not.toBe(0);
    expect(output).toMatch(/src\/one\.ts\(\d+,\d+\): error TS\d+/);
    expect(output).toContain("leaf");
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
