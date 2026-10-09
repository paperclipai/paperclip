import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLACEHOLDER_VERSION,
  buildPlaceholderFiles,
  parseArgs,
  promptOtp,
  spawnNpm,
  validatePackageName,
  waitForPackageVisible,
} from "./bootstrap-npm-package.mjs";

test("spawnNpm launches the npm.cmd shim on Windows", { skip: process.platform !== "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-npm-shim-test-"));
  try {
    writeFileSync(path.join(dir, "npm.cmd"), "@echo off\r\necho npm-shim-called %*\r\n");
    const result = spawnNpm(["view", "@paperclipai/adapter-agy-local", "version"], {
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /npm-shim-called "?view"? "?@paperclipai\/adapter-agy-local"? "?version"?/i);
    assert.throws(() => spawnNpm(["view", "@paperclipai/a&del"]), /unsafe for Windows command invocation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgs recognizes the publish flag", () => {
  assert.deepEqual(parseArgs(["@paperclipai/adapter-kimi-local", "--publish"]), {
    help: false,
    packageName: "@paperclipai/adapter-kimi-local",
    publish: true,
  });
});

test("parseArgs defaults to a dry run", () => {
  assert.deepEqual(parseArgs(["@paperclipai/adapter-kimi-local"]), {
    help: false,
    packageName: "@paperclipai/adapter-kimi-local",
    publish: false,
  });
});

test("parseArgs rejects a second package name", () => {
  assert.throws(() => parseArgs(["@paperclipai/a", "@paperclipai/b"]), /exactly one package name/);
});

test("parseArgs rejects unknown options", () => {
  assert.throws(() => parseArgs(["@paperclipai/a", "--skip-build"]), /unknown option/);
  assert.throws(() => parseArgs(["@paperclipai/a", "--otp", "123456"]), /unknown option/);
});

test("validatePackageName accepts @paperclipai scoped names", () => {
  validatePackageName("@paperclipai/adapter-kimi-local");
  validatePackageName("@paperclipai/plugin-workspace-diff");
});

test("validatePackageName rejects names outside the @paperclipai scope", () => {
  assert.throws(() => validatePackageName("left-pad"), /@paperclipai scope/);
  assert.throws(() => validatePackageName("@evil/adapter-kimi-local"), /@paperclipai scope/);
  assert.throws(() => validatePackageName("@paperclipai/UPPER"), /@paperclipai scope/);
});

test("buildPlaceholderFiles produces a publishable manifest at the placeholder version", () => {
  const files = buildPlaceholderFiles("@paperclipai/adapter-kimi-local");
  const manifest = JSON.parse(files["package.json"]);

  assert.equal(manifest.name, "@paperclipai/adapter-kimi-local");
  assert.equal(manifest.version, PLACEHOLDER_VERSION);
  assert.equal(manifest.publishConfig.access, "public");
  assert.deepEqual(manifest.files, ["index.js"]);
  assert.match(manifest.description, /[Pp]laceholder/);
});

test("buildPlaceholderFiles entry point throws with a pointer to the repo", () => {
  const files = buildPlaceholderFiles("@paperclipai/adapter-kimi-local");

  assert.match(files["index.js"], /^throw new Error\(/);
  assert.match(files["index.js"], /placeholder/);
  assert.match(files["index.js"], /github\.com\/paperclipai\/paperclip/);
  // The entry point must be valid JS: evaluating it should throw our message,
  // not a SyntaxError.
  assert.throws(() => new Function(files["index.js"])(), /placeholder that reserves/);
});

test("buildPlaceholderFiles README explains the placeholder", () => {
  const files = buildPlaceholderFiles("@paperclipai/adapter-kimi-local");
  assert.match(files["README.md"], /placeholder publish/);
  assert.match(files["README.md"], /release-bootstrap CI gate/);
});

test("promptOtp re-prompts until a non-empty code is entered", async () => {
  const answers = ["", "   ", " 123456 "];
  const rl = { question: async () => answers.shift() ?? "" };

  assert.equal(await promptOtp(rl, "publish"), "123456");
  assert.equal(answers.length, 0);
});

test("waitForPackageVisible requires consecutive sightings before reporting success", async () => {
  const states = [{ exists: false }, { exists: true }, { exists: false }, { exists: true }, { exists: true }];
  let sleeps = 0;

  const visible = await waitForPackageVisible("@paperclipai/x", {
    attempts: 10,
    consecutive: 2,
    inspect: () => states.shift() ?? { exists: true },
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(visible, true);
  // Five inspections happened; sleeps run between attempts, not before the first.
  assert.equal(sleeps, 4);
});

test("waitForPackageVisible times out when the package never appears", async () => {
  const visible = await waitForPackageVisible("@paperclipai/x", {
    attempts: 3,
    consecutive: 2,
    inspect: () => ({ exists: false }),
    sleep: async () => {},
  });

  assert.equal(visible, false);
});

test("waitForPackageVisible treats registry errors as misses and keeps polling", async () => {
  let calls = 0;
  const visible = await waitForPackageVisible("@paperclipai/x", {
    attempts: 6,
    consecutive: 2,
    inspect: () => {
      calls += 1;
      if (calls <= 2) throw new Error("transient registry error");
      return { exists: true };
    },
    sleep: async () => {},
  });

  assert.equal(visible, true);
  assert.equal(calls, 4);
});
