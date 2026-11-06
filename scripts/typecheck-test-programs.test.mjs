import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkCoverage,
  findUncheckedTests,
  PROGRAMS,
  PROVIDER_WORKSPACE,
  RESOLVE_ARGS,
  SANDBOX_PROVIDERS,
  typecheckTestPrograms,
} from "./typecheck-test-programs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

const harness = (overrides = {}) => {
  const calls = { pnpm: [], tsc: [], linked: 0, errors: [] };
  return {
    calls,
    options: {
      root: "/repo",
      programs: ["a/tsconfig.test.json", "b/tsconfig.test.json"],
      pnpm: (args, { cwd }) => {
        calls.pnpm.push({ args, cwd });
        return 0;
      },
      linkPlugins: () => {
        calls.linked += 1;
      },
      run: (args) => {
        calls.tsc.push(args);
        return { status: 0 };
      },
      checkFiles: () => [],
      log: () => {},
      logError: (message) => calls.errors.push(message),
      ...overrides,
    },
  };
};

test("findUncheckedTests reports only test files outside programs and other checks", () => {
  assert.deepEqual(
    findUncheckedTests({
      trackedFiles: ["a/x.test.ts", "a/y.spec.tsx", "a/z.test.tsx", "a/helper.ts", "a/n.test.mjs", "server/src/s.test.ts"],
      checkedFiles: ["a/x.test.ts", "a/y.spec.tsx"],
      checkedElsewhere: ["server/src/"],
    }),
    ["a/z.test.tsx"],
  );
});

test("every program exists, and the provider list matches the tracked provider packages", () => {
  for (const program of PROGRAMS) assert.ok(existsSync(path.join(root, program)), program);
  assert.ok(existsSync(path.join(root, PROVIDER_WORKSPACE, "pnpm-lock.yaml")));
  const tracked = execFileSync("git", ["ls-files", "packages/plugins/sandbox-providers"], { cwd: root, encoding: "utf8" });
  const manifests = tracked.split("\n").filter((file) => file.endsWith("/package.json"));
  assert.deepEqual(manifests.map((manifest) => path.dirname(manifest)).sort(), [...SANDBOX_PROVIDERS].sort());
});

test("no provider commits a lockfile, except the one Daytona already has", () => {
  const tracked = execFileSync("git", ["ls-files", "packages/plugins/sandbox-providers"], { cwd: root, encoding: "utf8" });
  assert.deepEqual(
    tracked.split("\n").filter((file) => file.endsWith("/pnpm-lock.yaml")),
    ["packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml"],
  );
});

test("a type error in one program still checks the rest and fails the run", () => {
  const { options, calls } = harness({
    run: (args) => {
      calls.tsc.push(args);
      return { status: args[1].startsWith("a/") ? 2 : 0 };
    },
  });
  assert.equal(typecheckTestPrograms(options), 2);
  assert.deepEqual(calls.tsc, [
    ["-p", "a/tsconfig.test.json"],
    ["-p", "b/tsconfig.test.json"],
  ]);
});

test("a killed compiler stops the run", () => {
  const { options, calls } = harness({
    run: (args) => {
      calls.tsc.push(args);
      return { status: null, signal: "SIGKILL" };
    },
  });
  assert.equal(typecheckTestPrograms(options), 1);
  assert.equal(calls.tsc.length, 1);
});

test("providers install frozen without scripts, then relink the SDK", () => {
  const { options, calls } = harness();
  assert.equal(typecheckTestPrograms(options), 0);
  const install = calls.pnpm.find(({ cwd }) => cwd === path.join("/repo", PROVIDER_WORKSPACE));
  assert.ok(install.args.includes("--frozen-lockfile"));
  assert.ok(install.args.includes("--ignore-scripts"));
  assert.equal(calls.linked, 1);
});

test("a stale provider lockfile is resolved in place, then installed frozen", () => {
  const workspace = path.join("/repo", PROVIDER_WORKSPACE);
  let frozenAttempts = 0;
  const { options, calls } = harness({
    pnpm: (args, { cwd }) => {
      calls.pnpm.push({ args, cwd });
      if (cwd !== workspace || !args.includes("--frozen-lockfile")) return 0;
      frozenAttempts += 1;
      return frozenAttempts === 1 ? 1 : 0;
    },
  });
  assert.equal(typecheckTestPrograms(options), 0);
  assert.deepEqual(
    calls.pnpm.filter(({ cwd }) => cwd === workspace).map(({ args }) => args.includes("--frozen-lockfile") ? "frozen" : args),
    ["frozen", RESOLVE_ARGS, "frozen"],
  );
  assert.ok(RESOLVE_ARGS.includes("--resolution-only") && RESOLVE_ARGS.includes("--ignore-scripts"));
  assert.equal(calls.tsc.length, 2);
});

test("a provider install that still fails stops before any program runs", () => {
  const { options, calls } = harness({
    pnpm: (args, { cwd }) => (cwd === path.join("/repo", PROVIDER_WORKSPACE) ? 1 : 0),
  });
  assert.equal(typecheckTestPrograms(options), 1);
  assert.equal(calls.tsc.length, 0);
  assert.match(calls.errors[0], /could not install the sandbox providers/);
});

test("an uncovered test file fails the run and is named", () => {
  const { options, calls } = harness({ checkFiles: () => ["a/z.test.tsx"] });
  assert.equal(typecheckTestPrograms(options), 1);
  assert.match(calls.errors[0], /a\/z\.test\.tsx/);
});

test("the coverage check fails closed when a program cannot be listed", () => {
  const { options } = harness({ checkFiles: () => null });
  assert.equal(typecheckTestPrograms(options), 1);
});

test("naming programs skips the coverage check", () => {
  let checked = false;
  const { options } = harness({
    coverage: false,
    checkFiles: () => {
      checked = true;
      return [];
    },
  });
  assert.equal(typecheckTestPrograms(options), 0);
  assert.equal(checked, false);
});

test("checkCoverage uses the compiler's file list, so a dropped sibling is caught", () => {
  const directory = mkdtempSync(path.join(root, "node_modules", ".typecheck-test-programs-"));
  try {
    const relative = path.relative(root, directory).split(path.sep).join("/");
    writeFileSync(path.join(directory, "foo.test.ts"), "export {};\n");
    writeFileSync(path.join(directory, "foo.test.tsx"), "export {};\n");
    writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, jsx: "preserve" }, include: ["*"] }));
    const unchecked = checkCoverage({
      root,
      programs: [`${relative}/tsconfig.json`],
      workspaceConfigs: () => [],
      trackedFiles: () => [`${relative}/foo.test.ts`, `${relative}/foo.test.tsx`],
    });
    assert.deepEqual(unchecked, [`${relative}/foo.test.tsx`]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a real type error in a test-style program makes tsc exit non-zero", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "typecheck-test-programs-"));
  try {
    writeFileSync(path.join(directory, "bad.test.ts"), "export const value: number = 'text';\n");
    writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ["*.ts"] }));
    const { status, stdout } = spawnSync(process.execPath, [tsc, "-p", directory, "--pretty", "false"], { encoding: "utf8" });
    assert.notEqual(status, 0);
    assert.match(stdout, /bad\.test\.ts.*TS2322/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
