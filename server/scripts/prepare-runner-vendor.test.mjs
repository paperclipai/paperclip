import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessRunnerBuild,
  beginRunnerBuild,
  buildInputsStampPath,
  readBuildInputsStamp,
  recordRunnerBuild,
} from "../../packages/paperclip-runner/scripts/build-inputs.mjs";
import {
  FORCE_REBUILD_VARIABLE,
  RUNNER_VENDOR_BUILD_COMMAND,
  TIMING_SCHEMA,
  decideRunnerVendorAction,
  prepareRunnerVendor,
  resolvePnpmInvocation,
} from "./prepare-runner-vendor.mjs";

const execFileAsync = promisify(execFile);
const prepareScript = fileURLToPath(new URL("./prepare-runner-vendor.mjs", import.meta.url));
const recordScript = fileURLToPath(
  new URL("../../packages/paperclip-runner/scripts/record-build-inputs.mjs", import.meta.url),
);
const executable = process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";

const roots = [];

function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** A throwaway workspace whose Runner is already built, with no stamp yet. */
function makeRepo() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "prepare-runner-vendor-"));
  roots.push(repoRoot);
  writeTree(repoRoot, {
    "package.json": "{}\n",
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - server\n",
    "tsconfig.base.json": "{}\n",
    "patches/acpx@0.13.1.patch": "--- a\n+++ b\n",
    "server/package.json": '{"name":"@paperclipai/server"}\n',
    "packages/paperclip-runner/package.json": '{"name":"@paperclipai/paperclip-runner"}\n',
    "packages/paperclip-runner/src/index.ts": "export const one = 1;\n",
    "packages/paperclip-runner/dist/index.js": "export const one = 1;\n",
    "packages/paperclip-runner/dist/live/index.js": "export {};\n",
    "packages/paperclip-runner/dist/testing.js": "export {};\n",
    "packages/paperclip-runner/dist/cli/acpx-runtime-sidecar.cjs": "module.exports = {};\n",
    [`packages/paperclip-runner/dist/bin/${executable}`]: "binary\n",
    "packages/paperclip-eval-kernel/src/index.ts": "export const kernel = 1;\n",
  });
  const packageRoot = path.join(repoRoot, "packages", "paperclip-runner");
  return { repoRoot, packageRoot };
}

/** What the Runner's build does around its steps when nothing changes meanwhile. */
function recordCurrentBuild({ repoRoot, packageRoot }) {
  beginRunnerBuild({ repoRoot, packageRoot });
  return recordRunnerBuild({ repoRoot, packageRoot });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("decideRunnerVendorAction", () => {
  const current = { current: true, code: "inputs_unchanged", detail: "unchanged" };
  const stale = { current: false, code: "inputs_changed", detail: "changed" };

  it("reuses a current build and rebuilds a stale one, carrying the assessment's reason", () => {
    expect(decideRunnerVendorAction({ env: {}, assessment: current })).toEqual({
      action: "reuse",
      code: "inputs_unchanged",
      detail: "unchanged",
    });
    expect(decideRunnerVendorAction({ env: {}, assessment: stale })).toEqual({
      action: "rebuild",
      code: "inputs_changed",
      detail: "changed",
    });
  });

  it("rebuilds a current build when the operator forces it", () => {
    expect(decideRunnerVendorAction({ env: { [FORCE_REBUILD_VARIABLE]: "1" }, assessment: current })).toEqual({
      action: "rebuild",
      code: "forced",
      detail: `${FORCE_REBUILD_VARIABLE}=1`,
    });
    // Only the documented value forces; an unrelated value does not.
    expect(decideRunnerVendorAction({ env: { [FORCE_REBUILD_VARIABLE]: "0" }, assessment: current }).action).toBe(
      "reuse",
    );
  });
});

describe("resolvePnpmInvocation", () => {
  it("runs the pnpm that is running the script, through Node for a JavaScript entry", () => {
    expect(resolvePnpmInvocation({ npm_execpath: "/corepack/pnpm/9.15.4/bin/pnpm.cjs" }, "/usr/bin/node")).toEqual({
      command: "/usr/bin/node",
      argsPrefix: ["/corepack/pnpm/9.15.4/bin/pnpm.cjs"],
    });
    expect(resolvePnpmInvocation({ npm_execpath: "/opt/pnpm/pnpm" }, "/usr/bin/node")).toEqual({
      command: "/opt/pnpm/pnpm",
      argsPrefix: [],
    });
    expect(resolvePnpmInvocation({ npm_execpath: "C:\\pnpm\\pnpm.exe" }, "node.exe")).toEqual({
      command: "C:\\pnpm\\pnpm.exe",
      argsPrefix: [],
    });
  });

  it("falls back to pnpm on PATH outside a pnpm script or under another package manager", () => {
    expect(resolvePnpmInvocation({}, "/usr/bin/node")).toEqual({ command: "pnpm", argsPrefix: [] });
    expect(resolvePnpmInvocation({ npm_execpath: "" }, "/usr/bin/node")).toEqual({ command: "pnpm", argsPrefix: [] });
    expect(resolvePnpmInvocation({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }, "/usr/bin/node")).toEqual({
      command: "pnpm",
      argsPrefix: [],
    });
  });
});

describe("prepareRunnerVendor", () => {
  it("still runs the Runner build the server build has always run", () => {
    // The Dockerfile's standalone `pnpm --filter @paperclipai/server build`
    // depends on this exact command producing a current vendored Runner.
    expect(RUNNER_VENDOR_BUILD_COMMAND).toBe("pnpm --filter @paperclipai/paperclip-runner build");
  });

  it("skips the rebuild when the recorded build is current and reports the check time", () => {
    const { repoRoot, packageRoot } = makeRepo();
    recordCurrentBuild({ repoRoot, packageRoot });
    const runs = [];
    const lines = [];

    const status = prepareRunnerVendor({
      repoRoot,
      env: {},
      run: (...args) => {
        runs.push(args);
        return 0;
      },
      log: (line) => lines.push(line),
    });

    expect(status).toBe(0);
    expect(runs).toEqual([]);
    expect(lines[0]).toMatch(/^prepare:runner-vendor: reusing the current Runner build \(inputs unchanged/);
    expect(lines[1]).toMatch(
      new RegExp(`^${TIMING_SCHEMA},action:reuse,reason:inputs_unchanged,check_ms:\\d+,build_ms:0$`),
    );
    expect(readBuildInputsStamp(buildInputsStampPath(packageRoot))).not.toBeNull();
  });

  it("rebuilds when the inputs changed, removing the stale stamp before the build starts", () => {
    const { repoRoot, packageRoot } = makeRepo();
    recordCurrentBuild({ repoRoot, packageRoot });
    writeFileSync(path.join(packageRoot, "src", "index.ts"), "export const one = 2;\n");
    const stampPath = buildInputsStampPath(packageRoot);
    const observed = [];
    const lines = [];
    const env = { npm_execpath: "/corepack/pnpm.cjs" };

    const status = prepareRunnerVendor({
      repoRoot,
      env,
      run: (command, options) => {
        observed.push({ command, ...options, stampPresent: readBuildInputsStamp(stampPath) !== null });
        return 0;
      },
      log: (line) => lines.push(line),
    });

    expect(status).toBe(0);
    expect(observed).toEqual([
      { command: RUNNER_VENDOR_BUILD_COMMAND, cwd: path.join(repoRoot, "server"), env, stampPresent: false },
    ]);
    expect(lines[0]).toMatch(/^prepare:runner-vendor: rebuilding the Runner \(inputs changed/);
    expect(lines[1]).toMatch(
      new RegExp(`^${TIMING_SCHEMA},action:rebuild,reason:inputs_changed,check_ms:\\d+,build_ms:\\d+,status:0$`),
    );
  });

  it("rebuilds when a file the build left under dist is gone, even one no consumer imports", () => {
    const { repoRoot, packageRoot } = makeRepo();
    recordCurrentBuild({ repoRoot, packageRoot });
    rmSync(path.join(packageRoot, "dist", "cli", "acpx-runtime-sidecar.cjs"));
    let runs = 0;
    const lines = [];

    const status = prepareRunnerVendor({
      repoRoot,
      env: {},
      run: () => {
        runs += 1;
        return 0;
      },
      log: (line) => lines.push(line),
    });

    expect(status).toBe(0);
    expect(runs).toBe(1);
    expect(lines[0]).toMatch(
      /^prepare:runner-vendor: rebuilding the Runner \(build output dist\/cli\/acpx-runtime-sidecar\.cjs is missing since /,
    );
    expect(lines[1]).toMatch(/,action:rebuild,reason:outputs_changed,/);
  });

  it("returns the build's failure status and leaves no stamp behind", () => {
    const { repoRoot, packageRoot } = makeRepo();
    const lines = [];

    const status = prepareRunnerVendor({
      repoRoot,
      env: {},
      run: () => 3,
      log: (line) => lines.push(line),
    });

    expect(status).toBe(3);
    expect(lines[0]).toMatch(/^prepare:runner-vendor: rebuilding the Runner \(no build stamp/);
    expect(lines[1]).toMatch(/,action:rebuild,reason:no_stamp,.*,status:3$/);
    expect(readBuildInputsStamp(buildInputsStampPath(packageRoot))).toBeNull();
  });

  it("rebuilds a current build when PAPERCLIP_RUNNER_VENDOR_REBUILD=1", () => {
    const { repoRoot, packageRoot } = makeRepo();
    recordCurrentBuild({ repoRoot, packageRoot });
    let runs = 0;
    const lines = [];

    const status = prepareRunnerVendor({
      repoRoot,
      env: { [FORCE_REBUILD_VARIABLE]: "1" },
      run: () => {
        runs += 1;
        return 0;
      },
      log: (line) => lines.push(line),
    });

    expect(status).toBe(0);
    expect(runs).toBe(1);
    expect(lines[1]).toMatch(/,action:rebuild,reason:forced,/);
  });

  it.skipIf(process.platform === "win32")(
    "end to end: the first server build rebuilds the Runner, the second reuses it, a change or a lost output rebuilds again",
    async () => {
      const { repoRoot, packageRoot } = makeRepo();
      // A stand-in pnpm that behaves like the Runner build: it records how it
      // was called, then brackets its (empty) step list with the same two
      // record-build-inputs.mjs calls the real build makes.
      const binDir = path.join(repoRoot, "bin");
      const argvLog = path.join(repoRoot, "pnpm-argv.log");
      mkdirSync(binDir);
      const pnpm = path.join(binDir, "pnpm");
      writeFileSync(
        pnpm,
        `${[
          "#!/bin/sh",
          "set -e",
          `printf '%s\\n' "$*" >> "${argvLog}"`,
          `"${process.execPath}" "${recordScript}" --begin --package-root "${packageRoot}" > /dev/null`,
          `"${process.execPath}" "${recordScript}" --finish --package-root "${packageRoot}" > /dev/null`,
        ].join("\n")}\n`,
      );
      chmodSync(pnpm, 0o755);
      const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
      delete env[FORCE_REBUILD_VARIABLE];
      // The suite itself may run under pnpm; the script must then take the
      // PATH fallback so the stand-in, not the real pnpm, receives the build.
      delete env.npm_execpath;
      const run = () => execFileAsync(process.execPath, [prepareScript, "--repo-root", repoRoot], { env });
      const calls = () => readFileSync(argvLog, "utf8").split("\n").filter(Boolean);

      const first = await run();
      expect(calls()).toEqual(["--filter @paperclipai/paperclip-runner build"]);
      expect(first.stdout).toMatch(/action:rebuild,reason:no_stamp,/);
      expect(assessRunnerBuild({ repoRoot, packageRoot }).current).toBe(true);

      const second = await run();
      expect(calls()).toHaveLength(1);
      expect(second.stdout).toMatch(/action:reuse,reason:inputs_unchanged,/);

      writeFileSync(path.join(packageRoot, "src", "index.ts"), "export const one = 2;\n");
      const third = await run();
      expect(calls()).toHaveLength(2);
      expect(third.stdout).toMatch(/action:rebuild,reason:inputs_changed,/);

      rmSync(path.join(packageRoot, "dist", "cli", "acpx-runtime-sidecar.cjs"));
      const fourth = await run();
      expect(calls()).toHaveLength(3);
      expect(fourth.stdout).toMatch(/action:rebuild,reason:outputs_changed,/);
      // The stand-in build does not recreate the helper, so the new stamp's
      // manifest no longer lists it and the next run reuses the build.
      const fifth = await run();
      expect(calls()).toHaveLength(3);
      expect(fifth.stdout).toMatch(/action:reuse,reason:inputs_unchanged,/);
    },
  );
});
