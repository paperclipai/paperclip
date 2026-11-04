import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildRunnerBinary, shouldSkipRunnerBinary } from "./build-binary.mjs";

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

test("buildRunnerBinary skips cargo build and removes staged binary when option is set", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runner-build-test-"));
  try {
    const stagedBinDir = path.join(tempDir, "dist", "bin");
    const executable = process.platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd";
    const stagedBin = path.join(stagedBinDir, executable);
    mkdirSync(stagedBinDir, { recursive: true });
    writeFileSync(stagedBin, "old-binary", "utf8");
    assert.equal(existsSync(stagedBin), true);

    let cargoCalled = false;
    let stageCalled = false;

    const result = await buildRunnerBinary({
      packageRoot: tempDir,
      env: { PAPERCLIP_SKIP_RUNNER_BINARY: "1" },
      spawnFn: () => {
        cargoCalled = true;
        return { status: 0 };
      },
      stageFn: () => {
        stageCalled = true;
      },
    });

    assert.equal(result.skipped, true);
    assert.equal(cargoCalled, false, "cargo must not be called when skipping binary");
    assert.equal(stageCalled, false, "stage must not be called when skipping binary");
    assert.equal(existsSync(stagedBin), false, "existing binary must be removed when skipping");
    assert.equal(existsSync(stagedBinDir), false, "staged bin dir must be removed when skipping");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildRunnerBinary executes cargo and stages binary when option is unset", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runner-build-test-"));
  try {
    let cargoCalled = false;
    let cargoCommand = "";
    let cargoArgs = [];
    let stageCalled = false;

    const result = await buildRunnerBinary({
      packageRoot: tempDir,
      env: {},
      spawnFn: (cmd, args) => {
        cargoCalled = true;
        cargoCommand = cmd;
        cargoArgs = args;
        return { status: 0 };
      },
      stageFn: async () => {
        stageCalled = true;
      },
    });

    assert.equal(result.skipped, false);
    assert.equal(cargoCalled, true);
    assert.equal(cargoCommand, "cargo");
    assert.ok(cargoArgs.includes("--bin"));
    assert.ok(cargoArgs.includes("paperclip-runnerd"));
    assert.equal(stageCalled, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildRunnerBinary fails without fallback when cargo is missing and option is unset", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "runner-build-test-"));
  try {
    const missingError = new Error("spawnSync cargo ENOENT");
    missingError.code = "ENOENT";

    await assert.rejects(
      async () => {
        await buildRunnerBinary({
          packageRoot: tempDir,
          env: {},
          spawnFn: () => ({
            error: missingError,
            status: null,
          }),
        });
      },
      (err) => {
        assert.equal(err.code, "ENOENT");
        return true;
      },
      "buildRunnerBinary must fail when cargo is missing, not fall back silently",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
