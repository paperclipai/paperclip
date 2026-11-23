import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkCoverage,
  checkCoverageAsync,
  findUncheckedTests,
  LOCKED_PROVIDERS,
  PROGRAMS,
  prepareTestPrograms,
  PROVIDER_WORKSPACE,
  RESOLVE_ARGS,
  SANDBOX_PROVIDER_PROGRAMS,
  SANDBOX_PROVIDERS,
  selectTestPrograms,
  typecheckTestPrograms,
  typecheckTestProgramsAsync,
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

test("the provider workspace lists every provider without its own lockfile by full path, so Dependabot sees them", () => {
  const workspace = readFileSync(path.join(root, PROVIDER_WORKSPACE, "pnpm-workspace.yaml"), "utf8");
  const listed = [...workspace.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((match) => match[1]);
  assert.ok(listed.every((entry) => !entry.includes("*")), "Dependabot does not expand a glob that starts with ../");
  const providers = listed.map((entry) => path.posix.normalize(path.posix.join(PROVIDER_WORKSPACE, entry)));
  const unlocked = SANDBOX_PROVIDERS.filter((provider) => !LOCKED_PROVIDERS.includes(provider));
  assert.deepEqual(providers.sort(), unlocked.sort());
});

test("each provider with its own lockfile is a provider and has that lockfile", () => {
  for (const provider of LOCKED_PROVIDERS) {
    assert.ok(SANDBOX_PROVIDERS.includes(provider), provider);
    assert.ok(existsSync(path.join(root, provider, "pnpm-lock.yaml")), provider);
  }
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

test("preparation runs on its own, and a run that skips it only checks", () => {
  const prepared = harness();
  assert.equal(prepareTestPrograms(prepared.options), 0);
  assert.ok(prepared.calls.pnpm.some(({ cwd }) => cwd === path.join("/repo", PROVIDER_WORKSPACE)));
  assert.equal(prepared.calls.linked, 1);
  assert.deepEqual(prepared.calls.tsc, []);

  const checked = harness();
  assert.equal(typecheckTestPrograms({ ...checked.options, prepare: false }), 0);
  assert.deepEqual(checked.calls.pnpm, []);
  assert.equal(checked.calls.linked, 0);
  assert.equal(checked.calls.tsc.length, 2);
});

test("a locked provider installs frozen from its own lockfile, outside any workspace", () => {
  const { options, calls } = harness();
  assert.equal(typecheckTestPrograms(options), 0);
  for (const provider of LOCKED_PROVIDERS) {
    const install = calls.pnpm.find(({ cwd }) => cwd === path.join("/repo", provider));
    assert.ok(install.args.includes("--ignore-workspace"));
    assert.ok(install.args.includes("--frozen-lockfile"));
    assert.ok(install.args.includes("--ignore-scripts"));
  }
});

// Each directory's first frozen install fails; resolution and the second frozen install pass.
const staleOnce = (directory, calls) => {
  const cwd = path.join("/repo", directory);
  let frozenAttempts = 0;
  return (args, options) => {
    calls.pnpm.push({ args, cwd: options.cwd });
    if (options.cwd !== cwd || !args.includes("--frozen-lockfile")) return 0;
    frozenAttempts += 1;
    return frozenAttempts === 1 ? 1 : 0;
  };
};
const installSteps = (calls, directory) =>
  calls.pnpm
    .filter(({ cwd }) => cwd === path.join("/repo", directory))
    .map(({ args }) => (args.includes("--frozen-lockfile") ? "frozen" : args));

test("a stale provider lockfile is resolved in place, then installed frozen", () => {
  const { options, calls } = harness();
  options.pnpm = staleOnce(PROVIDER_WORKSPACE, calls);
  assert.equal(typecheckTestPrograms(options), 0);
  assert.deepEqual(installSteps(calls, PROVIDER_WORKSPACE), ["frozen", RESOLVE_ARGS, "frozen"]);
  assert.ok(RESOLVE_ARGS.includes("--resolution-only") && RESOLVE_ARGS.includes("--ignore-scripts"));
  assert.equal(calls.tsc.length, 2);
});

test("a stale locked-provider lockfile is resolved in place, outside any workspace", () => {
  const [provider] = LOCKED_PROVIDERS;
  const { options, calls } = harness();
  options.pnpm = staleOnce(provider, calls);
  assert.equal(typecheckTestPrograms(options), 0);
  const [, resolve] = installSteps(calls, provider);
  assert.deepEqual(installSteps(calls, provider), ["frozen", resolve, "frozen"]);
  for (const flag of ["--ignore-workspace", "--resolution-only", "--ignore-scripts", "--no-frozen-lockfile"]) {
    assert.ok(resolve.includes(flag), flag);
  }
  assert.equal(calls.tsc.length, 2);
});

test("a locked provider install that still fails stops before any program runs", () => {
  const [provider] = LOCKED_PROVIDERS;
  const { options, calls } = harness({
    pnpm: (args, { cwd }) => (cwd === path.join("/repo", provider) ? 1 : 0),
  });
  assert.equal(typecheckTestPrograms(options), 1);
  assert.equal(calls.tsc.length, 0);
  assert.ok(calls.errors[0].includes(provider), calls.errors[0]);
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

test("selectTestPrograms skips sandbox providers and examples unless their inputs or SDK/shared changed", () => {
  const full = selectTestPrograms(null);
  assert.deepEqual(full.programs, PROGRAMS);
  assert.equal(full.includeProviders, true);
  assert.equal(full.checkCoverage, true);

  const serverOnly = selectTestPrograms(["server/src/services/issues.ts", "server/src/__tests__/issues.test.ts"]);
  assert.deepEqual(serverOnly.programs, []);
  assert.equal(serverOnly.includeProviders, false);
  assert.equal(serverOnly.includeRunnerEval, false);
  assert.equal(serverOnly.checkCoverage, false);

  const daytonaOnly = selectTestPrograms(["packages/plugins/sandbox-providers/daytona/src/plugin.ts"]);
  assert.deepEqual(daytonaOnly.programs, ["packages/plugins/sandbox-providers/daytona/tsconfig.test.json"]);
  assert.equal(daytonaOnly.includeProviders, true);
  assert.equal(daytonaOnly.includeRunnerEval, false);

  const cloudflare = selectTestPrograms(["packages/plugins/sandbox-providers/cloudflare/src/plugin.ts"]);
  assert.deepEqual(cloudflare.programs, [
    "packages/plugins/sandbox-providers/cloudflare/tsconfig.test.json",
    "packages/plugins/sandbox-providers/cloudflare/bridge-template/tsconfig.test.json",
  ]);
  assert.equal(cloudflare.includeProviders, true);

  const sdkChange = selectTestPrograms(["packages/plugins/sdk/src/index.ts"]);
  assert.equal(sdkChange.includeProviders, true);
  for (const providerProgram of SANDBOX_PROVIDER_PROGRAMS) {
    assert.ok(sdkChange.programs.includes(providerProgram), providerProgram);
  }
  assert.ok(sdkChange.programs.includes("packages/kv-demo-mcp-server/tsconfig.test.json"));
  assert.ok(sdkChange.programs.includes("packages/plugins/examples/plugin-orchestration-smoke-example/tsconfig.test.json"));

  const uiWithTest = selectTestPrograms(["ui/src/components/Card.tsx", "ui/src/components/Card.test.tsx"]);
  assert.deepEqual(uiWithTest.programs, ["tests/tsconfig.playwright.json"]);
  assert.equal(uiWithTest.includeProviders, false);
  assert.equal(uiWithTest.checkCoverage, true);
  assert.deepEqual(uiWithTest.changedTestFiles, ["ui/src/components/Card.test.tsx"]);

  const tsconfigEdit = selectTestPrograms(["ui/tsconfig.json"]);
  assert.equal(tsconfigEdit.checkCoverage, true);
  assert.equal(tsconfigEdit.changedTestFiles, null);
});

test("prepareTestPrograms can skip sandbox provider installs, runner eval prep, and plugin SDK", () => {
  const { options, calls } = harness();
  assert.equal(
    prepareTestPrograms({ ...options, includeProviders: false, includeRunnerEval: false, includePluginSdk: false }),
    0,
  );
  assert.deepEqual(calls.pnpm, []);
  assert.equal(calls.linked, 0);

  const evalOnly = harness();
  assert.equal(
    prepareTestPrograms({ ...evalOnly.options, includeProviders: false, includeRunnerEval: true, includePluginSdk: false }),
    0,
  );
  assert.equal(evalOnly.calls.pnpm.length, 1);
  assert.ok(evalOnly.calls.pnpm[0].args.includes("ensure:eval-build-deps"));
  assert.equal(evalOnly.calls.linked, 0);
});

test("typecheckTestProgramsAsync runs programs concurrently up to the limit and preserves failure/signal semantics", async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const status = await typecheckTestProgramsAsync({
    root: "/repo",
    programs: ["a/tsconfig.test.json", "b/tsconfig.test.json", "c/tsconfig.test.json", "d/tsconfig.test.json"],
    prepare: false,
    coverage: false,
    concurrency: 2,
    checkers: 1,
    log: () => {},
    logError: () => {},
    runAsync: async (args) => {
      started.push(args);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: args[1].startsWith("b/") ? 2 : 0, signal: null, output: "", durationMs: 10 };
    },
  });
  assert.equal(status, 2);
  assert.equal(peak, 2);
  assert.equal(started.length, 4);
  assert.deepEqual(started[0], ["-p", "a/tsconfig.test.json", "--checkers", "1"]);

  // A killed compiler stops queuing further programs.
  const killedStarts = [];
  const killedStatus = await typecheckTestProgramsAsync({
    root: "/repo",
    programs: ["a/tsconfig.test.json", "b/tsconfig.test.json", "c/tsconfig.test.json"],
    prepare: false,
    coverage: false,
    concurrency: 1,
    log: () => {},
    logError: () => {},
    runAsync: async (args) => {
      killedStarts.push(args[1]);
      return { status: 1, signal: "SIGKILL", output: "", durationMs: 5 };
    },
  });
  assert.equal(killedStatus, 1);
  assert.deepEqual(killedStarts, ["a/tsconfig.test.json"]);
});

test("checkCoverageAsync checks targeted files with early exit and skips uninstalled providers", async () => {
  const listed = [];
  const covered = await checkCoverageAsync({
    root: "/repo",
    includeProviders: false,
    onlyFiles: ["ui/src/Card.test.tsx"],
    concurrency: 1,
    workspaceConfigs: () => ["cli/tsconfig.json", "ui/tsconfig.json"],
    trackedFiles: () => ["ui/src/Card.test.tsx", "packages/plugins/sandbox-providers/daytona/src/x.test.ts"],
    listFilesAsync: async (config) => {
      listed.push(config);
      return {
        status: 0,
        output: "",
        files: config === "ui/tsconfig.json" ? ["ui/src/Card.test.tsx"] : [],
      };
    },
    logError: () => {},
  });
  assert.deepEqual(covered, []);
  // Prioritized ui/tsconfig.json first and stopped immediately once covered.
  assert.deepEqual(listed, ["ui/tsconfig.json"]);

  const uncovered = await checkCoverageAsync({
    root: "/repo",
    includeProviders: false,
    onlyFiles: ["ui/src/Orphan.test.tsx"],
    concurrency: 2,
    workspaceConfigs: () => ["ui/tsconfig.json"],
    trackedFiles: () => ["ui/src/Orphan.test.tsx"],
    listFilesAsync: async (config) => {
      assert.ok(!SANDBOX_PROVIDER_PROGRAMS.includes(config), `should skip uninstalled provider ${config}`);
      return { status: 0, output: "", files: [] };
    },
    logError: () => {},
  });
  assert.deepEqual(uncovered, ["ui/src/Orphan.test.tsx"]);
});
