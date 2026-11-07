import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRunnerBinary, shouldSkipRunnerBinary } from "./build-binary.mjs";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

test("shouldSkipRunnerBinary identifies truthy environment flags", () => {
  assert.equal(shouldSkipRunnerBinary({}), false);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "" }), false);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "0" }), false);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "false" }), false);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "no" }), false);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "1" }), true);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "true" }), true);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "TRUE" }), true);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "yes" }), true);
  assert.equal(shouldSkipRunnerBinary({ PAPERCLIP_SKIP_RUNNER_BINARY: "YES" }), true);
});

test("the package build reaches the binary step only through the skip-aware script", () => {
  const steps = packageJson.scripts.build.split(" && ");
  assert.ok(steps.includes("node scripts/build-binary.mjs"));
  assert.equal(steps.includes("pnpm run build:binary"), false);
  assert.ok(steps.indexOf("node scripts/build-binary.mjs") < steps.indexOf("node scripts/record-build-inputs.mjs --finish"));
});

test("buildRunnerBinary skips the binary step and removes a staged binary when the option is set", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runner-build-test-"));
  try {
    const stagedBinDir = path.join(tempDir, "dist", "bin");
    const executable = process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
    const stagedBin = path.join(stagedBinDir, executable);
    mkdirSync(stagedBinDir, { recursive: true });
    writeFileSync(stagedBin, "old-binary", "utf8");

    let spawned = false;
    const result = await buildRunnerBinary({
      packageRoot: tempDir,
      env: { PAPERCLIP_SKIP_RUNNER_BINARY: "1" },
      spawnFn: () => {
        spawned = true;
        return { status: 0 };
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(spawned, false, "the binary step must not run when skipping the binary");
    assert.equal(existsSync(stagedBin), false, "an existing binary must be removed when skipping");
    assert.equal(existsSync(stagedBinDir), false, "the staged bin directory must be removed when skipping");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildRunnerBinary runs the package's build:binary script when the option is unset", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runner-build-test-"));
  try {
    const calls = [];
    const result = await buildRunnerBinary({
      packageRoot: tempDir,
      env: {},
      spawnFn: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        return { status: 0 };
      },
    });

    assert.equal(result.skipped, false);
    assert.deepEqual(calls, [{ command: "pnpm", args: ["run", "build:binary"], cwd: tempDir }]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildRunnerBinary runs build:binary through the pnpm that runs the build", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runner-build-test-"));
  try {
    const run = async (env, platform) => {
      const calls = [];
      await buildRunnerBinary({
        packageRoot: tempDir,
        env,
        platform,
        nodeExecPath: "/opt/node/bin/node",
        spawnFn: (command, args, options) => {
          calls.push({ command, args, shell: options.shell });
          return { status: 0 };
        },
      });
      return calls[0];
    };

    assert.deepEqual(await run({ npm_execpath: "/corepack/pnpm/bin/pnpm.cjs" }, "linux"), {
      command: "/opt/node/bin/node",
      args: ["/corepack/pnpm/bin/pnpm.cjs", "run", "build:binary"],
      shell: false,
    });
    assert.deepEqual(await run({ npm_execpath: "/usr/local/bin/pnpm" }, "linux"), {
      command: "/usr/local/bin/pnpm",
      args: ["run", "build:binary"],
      shell: false,
    });
    assert.deepEqual(await run({}, "win32"), { command: "pnpm", args: ["run", "build:binary"], shell: true });
    assert.deepEqual(await run({}, "linux"), { command: "pnpm", args: ["run", "build:binary"], shell: false });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildRunnerBinary fails without fallback when the binary step cannot start", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runner-build-test-"));
  try {
    const missingError = new Error("spawnSync pnpm ENOENT");
    missingError.code = "ENOENT";

    await assert.rejects(
      () => buildRunnerBinary({
        packageRoot: tempDir,
        env: {},
        spawnFn: () => ({ error: missingError, status: null }),
      }),
      (err) => {
        assert.equal(err.code, "ENOENT");
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
