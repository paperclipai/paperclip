import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { typecheckLayers } from "./typecheck-layers.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realTsc = path.join(serverRoot, "node_modules", "typescript", "bin", "tsc");
const outputDir = (root) => path.join(root, "node_modules", ".cache", "paperclip-typecheck");

describe("typecheckLayers incremental cache soundness", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function compilerFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "typecheck-layers-inc-"));
    roots.push(root);
    mkdirSync(path.join(root, "src", "__tests__"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    writeFileSync(
      path.join(root, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["src"],
        exclude: ["src/__tests__"],
      })}\n`,
    );
    writeFileSync(
      path.join(root, "src", "__tests__", "tsconfig.json"),
      `${JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { noEmit: true, rootDir: "../.." },
        include: ["."],
      })}\n`,
    );
    writeFileSync(path.join(root, "src", "leaf.ts"), `export const leaf = (): number => 1;\n`);
    writeFileSync(
      path.join(root, "src", "one.ts"),
      `import { leaf } from "./leaf.js";\nimport { two } from "./two.js";\nexport const one = (n = 0): number => (n > 0 ? two(n - 1) : leaf());\n`,
    );
    writeFileSync(
      path.join(root, "src", "two.ts"),
      `import { one } from "./one.js";\nexport const two = (n = 0): number => (n > 0 ? one(n - 1) : 1);\n`,
    );
    writeFileSync(
      path.join(root, "src", "route.ts"),
      `import { one } from "./one.js";\nexport const route = (): number => one();\n`,
    );
    writeFileSync(
      path.join(root, "src", "route.test.ts"),
      `import { route } from "./route.js";\nexport const routeCheck: number = route();\n`,
    );
    writeFileSync(
      path.join(root, "src", "__tests__", "tree.test.ts"),
      `import { route } from "../route.js";\nexport const treeCheck: number = route();\n`,
    );
    return root;
  }

  function runReal(root, options = {}) {
    const chunks = [];
    const status = typecheckLayers({
      serverRoot: root,
      log: () => {},
      logError: (msg) => chunks.push(`${msg}\n`),
      run: (args, { cwd }) => {
        const result = spawnSync(process.execPath, [realTsc, ...args, "--pretty", "false"], {
          cwd,
          encoding: "utf8",
        });
        if (result.error) throw result.error;
        chunks.push(result.stdout, result.stderr);
        return { status: result.status ?? 1, signal: result.signal };
      },
      ...options,
    });
    return { status, output: chunks.join("") };
  }

  function backdateDirectory(dir, ageSeconds = 3600) {
    const past = new Date(Date.now() - ageSeconds * 1000);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) backdateDirectory(fullPath, ageSeconds);
      else utimesSync(fullPath, past, past);
    }
  }

  it("preserves tsbuildinfo across warm runs and avoids rewriting unchanged layer configs", () => {
    const root = compilerFixture();
    expect(runReal(root)).toEqual({ status: 0, output: "" });

    const out = outputDir(root);
    const buildInfos = readdirSync(out).filter((name) => name.endsWith(".tsbuildinfo")).sort();
    expect(buildInfos).toEqual(
      expect.arrayContaining(["above.tsbuildinfo", "below.tsbuildinfo", "cycle.tsbuildinfo", "tests.tsbuildinfo"]),
    );
    expect(buildInfos.some((name) => name.startsWith("test-tree-"))).toBe(true);
    expect(existsSync(path.join(out, "layer-map.json"))).toBe(true);

    backdateDirectory(out, 3600);
    const beforeMtime = statSync(path.join(out, "tsconfig.below.json")).mtimeMs;

    expect(runReal(root)).toEqual({ status: 0, output: "" });
    expect(statSync(path.join(out, "tsconfig.below.json")).mtimeMs).toBe(beforeMtime);
  }, 60_000);

  it("catches export type regressions across layers and test trees even when restored cache mtimes are older", () => {
    const root = compilerFixture();
    expect(runReal(root)).toEqual({ status: 0, output: "" });

    // Simulate restoring a master cache onto a fresh git checkout whose source files are newer.
    backdateDirectory(outputDir(root), 3600);

    // Change route() return type from number to string; tests + test-tree must fail.
    writeFileSync(
      path.join(root, "src", "route.ts"),
      `import { one } from "./one.js";\nexport const route = (): string => String(one());\n`,
    );
    const failed = runReal(root);
    expect(failed.status).not.toBe(0);
    expect(failed.output).toMatch(/route\.test\.ts.*TS2322/);
    expect(failed.output).toMatch(/tree\.test\.ts.*TS2322/);
  }, 60_000);

  it("prunes stale declarations for deleted source files so dangling imports fail with TS2307", () => {
    const root = compilerFixture();
    writeFileSync(path.join(root, "src", "extra.ts"), `export const extra = 42;\n`);
    writeFileSync(
      path.join(root, "src", "route.ts"),
      `import { one } from "./one.js";\nimport { extra } from "./extra.js";\nexport const route = (): number => one() + extra;\n`,
    );
    expect(runReal(root)).toEqual({ status: 0, output: "" });
    expect(existsSync(path.join(outputDir(root), "dts", "extra.d.ts"))).toBe(true);

    rmSync(path.join(root, "src", "extra.ts"));
    const failed = runReal(root);
    expect(failed.status).not.toBe(0);
    expect(existsSync(path.join(outputDir(root), "dts", "extra.d.ts"))).toBe(false);
    expect(failed.output).toMatch(/route\.ts.*TS2307/);
  }, 60_000);

  it("invalidates affected layers when a file moves from below to above", () => {
    const root = compilerFixture();
    writeFileSync(path.join(root, "src", "mover.ts"), `export const moved = (): number => 1;\n`);
    expect(runReal(root)).toEqual({ status: 0, output: "" });

    // Adding an import on `one.ts` moves `mover.ts` from `below` into `above`.
    writeFileSync(
      path.join(root, "src", "mover.ts"),
      `import { one } from "./one.js";\nexport const moved = (): number => one() + 1;\n`,
    );
    const result = runReal(root);
    expect(result).toEqual({ status: 0, output: "" });
  }, 60_000);

  it("starts clean when dts exists without layer-map.json or when clean is requested", () => {
    const root = compilerFixture();
    expect(runReal(root)).toEqual({ status: 0, output: "" });

    const out = outputDir(root);
    const orphanDts = path.join(out, "dts", "phantom.d.ts");
    writeFileSync(orphanDts, "export declare const phantom: number;\n");
    rmSync(path.join(out, "layer-map.json"));

    expect(runReal(root)).toEqual({ status: 0, output: "" });
    expect(existsSync(orphanDts)).toBe(false);
    expect(existsSync(path.join(out, "layer-map.json"))).toBe(true);

    const marker = path.join(out, "marker.txt");
    writeFileSync(marker, "stale");
    expect(runReal(root, { clean: true })).toEqual({ status: 0, output: "" });
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
});
