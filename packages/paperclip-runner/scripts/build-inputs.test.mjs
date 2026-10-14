import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  BUILD_INPUTS_SCHEMA,
  PENDING_RECORD_MAX_AGE_MS,
  assessRunnerBuild,
  beginRunnerBuild,
  buildInputsPendingDirectory,
  buildInputsPendingPath,
  buildInputsStampPath,
  collectBuildInputFiles,
  collectBuildOutputFiles,
  computeBuildInputsDigest,
  currentBuildId,
  expectedBuildOutputs,
  readBuildInputsStamp,
  recordRunnerBuild,
} from "./build-inputs.mjs";

const execFileAsync = promisify(execFile);
const recordScript = fileURLToPath(new URL("./record-build-inputs.mjs", import.meta.url));
/** A child of this process names its build after this process, as `--begin` names it after the shell. */
const childBuildId = String(process.pid);

async function waitFor(condition, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The whole build chain the way pnpm runs it: one shell, `--begin` first,
 * `--finish` last, with a stand-in for the build steps that waits for a
 * marker file so two chains can be held open at the same time.
 */
function runChainInShell(shell, packageRoot, marker) {
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  const wait =
    `${quote(process.execPath)} -e ${quote(
      "const fs=require('node:fs');const [marker]=process.argv.slice(1);const deadline=Date.now()+10000;" +
        "(function poll(){if(fs.existsSync(marker))return;if(Date.now()>deadline)process.exit(3);setTimeout(poll,20)})()",
    )} ${quote(marker)}`;
  const phase = (flag) => `${quote(process.execPath)} ${quote(recordScript)} ${flag} --package-root ${quote(packageRoot)}`;
  return execFileAsync(shell, ["-c", `${phase("--begin")} && ${wait} && ${phase("--finish")}`]);
}

async function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

/**
 * A throwaway repo with one Runner source file, one Rust source, two root
 * patches, built outputs (the four every consumer reads plus one helper that
 * is only opened by path), and the usual noise.
 */
async function makeRepo() {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "runner-build-inputs-"));
  await writeTree(repoRoot, {
    "package.json": "{}\n",
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "tsconfig.base.json": "{}\n",
    "patches/acpx@0.13.1.patch": "--- a\n+++ b\n",
    "patches/pi-acp@0.0.33.patch": "--- c\n+++ d\n",
    "packages/paperclip-runner/package.json": '{"name":"@paperclipai/paperclip-runner"}\n',
    "packages/paperclip-runner/src/index.ts": "export const one = 1;\n",
    "packages/paperclip-runner/runner/src/main.rs": "fn main() {}\n",
    "packages/paperclip-runner/runner/target/release/paperclip-runnerd": "binary\n",
    "packages/paperclip-runner/dist/index.js": "export const one = 1;\n",
    "packages/paperclip-runner/dist/live/index.js": "export {};\n",
    "packages/paperclip-runner/dist/testing.js": "export {};\n",
    "packages/paperclip-runner/dist/bin/paperclip-runnerd": "binary\n",
    "packages/paperclip-runner/dist/cli/acpx-runtime-sidecar.cjs": "module.exports = {};\n",
    "packages/paperclip-runner/dist-browser/index.js": "browser\n",
    "packages/paperclip-runner/node_modules/dep/index.js": "dep\n",
    "packages/paperclip-runner/.vite/cache.json": "{}\n",
    "packages/paperclip-eval-kernel/src/index.ts": "export const kernel = 1;\n",
    "packages/paperclip-eval-kernel/dist/index.js": "export const kernel = 1;\n",
  });
  const packageRoot = path.join(repoRoot, "packages", "paperclip-runner");
  return { repoRoot, packageRoot };
}

const INPUT_FILE_COUNT = 10;
const OUTPUT_FILE_COUNT = 5;

async function withRepo(action) {
  const repo = await makeRepo();
  try {
    await action(repo);
  } finally {
    await rm(repo.repoRoot, { recursive: true, force: true });
  }
}

/** A complete, undisturbed build: begin, (nothing changes), finish. */
function recordCurrentBuild({ repoRoot, packageRoot, platform, arch, now }) {
  beginRunnerBuild({ repoRoot, packageRoot, platform, arch, now });
  return recordRunnerBuild({ repoRoot, packageRoot, platform, arch, now });
}

test("the input set covers sources, the eval kernel, root patches and root config, and skips outputs and caches", async () => {
  await withRepo(async ({ repoRoot }) => {
    const files = collectBuildInputFiles(repoRoot);
    assert.deepEqual(files, [
      "package.json",
      "packages/paperclip-eval-kernel/src/index.ts",
      "packages/paperclip-runner/package.json",
      "packages/paperclip-runner/runner/src/main.rs",
      "packages/paperclip-runner/src/index.ts",
      "patches/acpx@0.13.1.patch",
      "patches/pi-acp@0.0.33.patch",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
    ]);
    assert.equal(files.length, INPUT_FILE_COUNT);
  });
});

test("the output manifest lists every file under dist with its size, and nothing outside it", async () => {
  await withRepo(async ({ packageRoot }) => {
    const outputs = collectBuildOutputFiles(packageRoot);
    assert.deepEqual(outputs, [
      { path: "dist/bin/paperclip-runnerd", size: 7 },
      { path: "dist/cli/acpx-runtime-sidecar.cjs", size: 21 },
      { path: "dist/index.js", size: 22 },
      { path: "dist/live/index.js", size: 11 },
      { path: "dist/testing.js", size: 11 },
    ]);
    assert.equal(outputs.length, OUTPUT_FILE_COUNT);
  });
});

test("the digest is stable, ignores outputs and caches, and tracks every kind of input", async () => {
  await withRepo(async ({ repoRoot }) => {
    const before = computeBuildInputsDigest(repoRoot);
    assert.equal(before.schema, BUILD_INPUTS_SCHEMA);
    assert.equal(before.fileCount, INPUT_FILE_COUNT);
    assert.equal(computeBuildInputsDigest(repoRoot).digest, before.digest, "two reads disagree");

    // Outputs, dependencies, caches and the Rust target directory may change freely.
    await writeTree(repoRoot, {
      "packages/paperclip-runner/dist/index.js": "export const one = 2;\n",
      "packages/paperclip-runner/dist/cli/acpx-runtime-sidecar.cjs": "changed\n",
      "packages/paperclip-runner/dist-browser/index.js": "changed\n",
      "packages/paperclip-runner/node_modules/dep/index.js": "changed\n",
      "packages/paperclip-runner/.vite/cache.json": '{"changed":true}\n',
      "packages/paperclip-runner/runner/target/release/paperclip-runnerd": "rebuilt\n",
      "packages/paperclip-eval-kernel/dist/index.js": "changed\n",
    });
    assert.equal(computeBuildInputsDigest(repoRoot).digest, before.digest, "an output changed the digest");

    // Every input kind changes it: TypeScript, Rust, the eval kernel, a root
    // patch, root config, a new file, a rename.
    const seen = new Set([before.digest]);
    const expectChange = async (label, files) => {
      await writeTree(repoRoot, files);
      const next = computeBuildInputsDigest(repoRoot).digest;
      assert.ok(!seen.has(next), `${label} did not change the digest`);
      seen.add(next);
    };
    await expectChange("a Runner source", { "packages/paperclip-runner/src/index.ts": "export const one = 2;\n" });
    await expectChange("a Rust source", { "packages/paperclip-runner/runner/src/main.rs": "fn main() { }\n" });
    await expectChange("an eval-kernel source", { "packages/paperclip-eval-kernel/src/index.ts": "export const kernel = 2;\n" });
    await expectChange("the pi-acp patch the build copies into dist", { "patches/pi-acp@0.0.33.patch": "--- c\n+++ d\n+e\n" });
    await expectChange("the acpx patch the profile check hashes", { "patches/acpx@0.13.1.patch": "--- a\n+++ b\n+c\n" });
    await expectChange("a new patch", { "patches/brace-expansion@5.0.9.patch": "--- x\n+++ y\n" });
    await expectChange("the lockfile", { "pnpm-lock.yaml": "lockfileVersion: 9\nchanged: true\n" });
    await expectChange("the base tsconfig", { "tsconfig.base.json": '{"compilerOptions":{}}\n' });
    await expectChange("a new file", { "packages/paperclip-runner/protocol/new.json": "{}\n" });
    await rm(path.join(repoRoot, "packages/paperclip-runner/protocol/new.json"));
    await expectChange("a renamed file", { "packages/paperclip-runner/protocol/renamed.json": "{}\n" });
  });
});

test("a symlink is hashed as its target path, not followed", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const before = computeBuildInputsDigest(repoRoot);
    await symlink("../node_modules/dep", path.join(packageRoot, "src", "linked"), "dir");
    const linked = computeBuildInputsDigest(repoRoot);
    assert.notEqual(linked.digest, before.digest, "the link itself is an input");
    assert.equal(linked.fileCount, before.fileCount + 1, "the link target's files were followed");
    await writeFile(path.join(packageRoot, "node_modules/dep/index.js"), "changed\n");
    assert.equal(computeBuildInputsDigest(repoRoot).digest, linked.digest, "a change behind the link changed the digest");
  });
});

test("a build is current only with a matching stamp and every recorded output intact", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const platform = "linux";
    const arch = "x64";
    const assess = () => assessRunnerBuild({ repoRoot, packageRoot, platform, arch });

    assert.equal(assess().current, false);
    assert.equal(assess().code, "no_stamp");

    const record = recordCurrentBuild({ repoRoot, packageRoot, platform, arch, now: () => new Date(0) });
    assert.equal(record.recorded, true);
    assert.equal(record.stampPath, buildInputsStampPath(packageRoot));
    const stamp = readBuildInputsStamp(record.stampPath);
    assert.equal(stamp.schema, BUILD_INPUTS_SCHEMA);
    assert.equal(stamp.digest, record.digest);
    assert.equal(stamp.fileCount, INPUT_FILE_COUNT);
    assert.equal(stamp.byteCount, record.byteCount);
    assert.equal(stamp.platform, platform);
    assert.equal(stamp.arch, arch);
    assert.equal(stamp.startedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(stamp.recordedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(stamp.outputCount, OUTPUT_FILE_COUNT);
    assert.deepEqual(stamp.outputs, collectBuildOutputFiles(packageRoot));
    const current = assess();
    assert.equal(current.current, true, current.detail);
    assert.equal(current.code, "inputs_unchanged");
    assert.match(current.detail, /10 files and 5 outputs checked/);

    assert.equal(assessRunnerBuild({ repoRoot, packageRoot, platform: "win32", arch }).code, "platform_mismatch");
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot, platform, arch: "arm64" }).code, "platform_mismatch");

    // The four outputs every consumer reads are checked by name.
    for (const output of expectedBuildOutputs(packageRoot, platform)) {
      const content = await readFile(output);
      await rm(output);
      const missing = assess();
      assert.equal(missing.current, false, `${output} missing still counted as current`);
      assert.equal(missing.code, "missing_output");
      assert.match(missing.detail, new RegExp(path.basename(output)));
      await writeFile(output, content);
    }
    assert.equal(assess().current, true);

    // So is every other file the build left under dist: a helper that is only
    // opened by path must be there, at the size the build wrote.
    const helper = path.join(packageRoot, "dist", "cli", "acpx-runtime-sidecar.cjs");
    const helperContent = await readFile(helper);
    await rm(helper);
    const gone = assess();
    assert.equal(gone.current, false, "a missing helper still counted as current");
    assert.equal(gone.code, "outputs_changed");
    assert.match(gone.detail, /^build output dist\/cli\/acpx-runtime-sidecar\.cjs is missing since the build recorded at /);
    await writeFile(helper, helperContent);
    assert.equal(assess().current, true);

    await truncate(helper, 3);
    const truncated = assess();
    assert.equal(truncated.current, false, "a truncated helper still counted as current");
    assert.equal(truncated.code, "outputs_changed");
    assert.match(truncated.detail, /^build output dist\/cli\/acpx-runtime-sidecar\.cjs is changed size since /);
    await writeFile(helper, helperContent);
    assert.equal(assess().current, true);

    // A file the build did not produce may appear without invalidating it.
    await writeFile(path.join(packageRoot, "dist", "extra.txt"), "later\n");
    assert.equal(assess().current, true);

    await writeFile(path.join(packageRoot, "src", "index.ts"), "export const one = 3;\n");
    const changed = assess();
    assert.equal(changed.current, false);
    assert.equal(changed.code, "inputs_changed");

    await writeFile(record.stampPath, JSON.stringify({ ...readBuildInputsStamp(record.stampPath), schema: "other" }));
    assert.equal(assess().code, "schema_mismatch");
    await writeFile(record.stampPath, JSON.stringify({ ...readBuildInputsStamp(record.stampPath), schema: BUILD_INPUTS_SCHEMA, outputs: undefined }));
    assert.equal(assess().code, "schema_mismatch", "a stamp without an output manifest was trusted");
    await writeFile(record.stampPath, "not json");
    assert.equal(assess().code, "no_stamp");
  });
});

test("an input edited while the build runs leaves no stamp, so the next consumer rebuilds", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const stampPath = buildInputsStampPath(packageRoot);
    const pendingPath = buildInputsPendingPath(packageRoot, currentBuildId());
    const assess = () => assessRunnerBuild({ repoRoot, packageRoot });

    // A previous good build, then a new build begins: the old stamp is gone at
    // once, because the outputs are about to be replaced.
    recordCurrentBuild({ repoRoot, packageRoot });
    assert.equal(assess().current, true);
    const pending = beginRunnerBuild({ repoRoot, packageRoot, now: () => new Date(1000) });
    assert.equal(pending.pendingPath, pendingPath);
    assert.equal(pending.buildId, String(process.ppid), "a build is named after the shell that runs its chain");
    assert.equal(readBuildInputsStamp(stampPath), null, "the old stamp survived the start of a new build");
    assert.equal(readBuildInputsStamp(pendingPath).digest, pending.digest);
    assert.equal(readBuildInputsStamp(pendingPath).buildId, pending.buildId);
    assert.equal(assess().code, "no_stamp");

    // The build "compiles" the old source, then an edit lands before it ends.
    await writeFile(path.join(packageRoot, "src", "index.ts"), "export const one = 2;\n");
    const result = recordRunnerBuild({ repoRoot, packageRoot });
    assert.equal(result.recorded, false);
    assert.equal(result.code, "inputs_changed_during_build");
    assert.match(result.detail, /^inputs changed while the build ran \(digest [0-9a-f]{12} at start, [0-9a-f]{12} now\); the next consumer rebuilds$/);
    assert.equal(result.startedAt, "1970-01-01T00:00:01.000Z");
    assert.equal(readBuildInputsStamp(stampPath), null, "a stamp was written for a build whose inputs moved");
    assert.equal(readBuildInputsStamp(pendingPath), null, "the pending record was left behind");
    assert.equal(assess().code, "no_stamp");

    // An undisturbed build records normally, and only the pending record's
    // start time is kept.
    const record = recordCurrentBuild({ repoRoot, packageRoot });
    assert.equal(record.recorded, true);
    assert.equal(readBuildInputsStamp(pendingPath), null);
    assert.equal(assess().current, true);
  });
});

test("a build that did not begin, or that left a required output missing, cannot be recorded", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const stampPath = buildInputsStampPath(packageRoot);

    recordCurrentBuild({ repoRoot, packageRoot });
    assert.throws(
      () => recordRunnerBuild({ repoRoot, packageRoot }),
      new RegExp(
        `no pending build inputs for build ${process.ppid} or ${process.pid} under .*paperclip-runner-build-inputs\\.pending: ` +
          "the Runner build must start with `node scripts/record-build-inputs\\.mjs --begin`",
      ),
    );
    assert.equal(readBuildInputsStamp(stampPath), null, "the previous stamp outlived a build that did not begin");

    // Another build's record is not this build's: a chain that did not begin
    // cannot finish on the strength of one that is still running.
    beginRunnerBuild({ repoRoot, packageRoot, buildId: "other-shell" });
    assert.throws(() => recordRunnerBuild({ repoRoot, packageRoot }), /no pending build inputs for build /);
    assert.equal(
      readBuildInputsStamp(buildInputsPendingPath(packageRoot, "other-shell")).digest,
      computeBuildInputsDigest(repoRoot).digest,
      "a build that did not begin consumed another build's record",
    );
    await rm(buildInputsPendingPath(packageRoot, "other-shell"));

    beginRunnerBuild({ repoRoot, packageRoot });
    await rm(path.join(packageRoot, "dist", "testing.js"));
    assert.throws(
      () => recordRunnerBuild({ repoRoot, packageRoot }),
      /the Runner build finished without producing dist\/testing\.js/,
    );
    assert.equal(readBuildInputsStamp(stampPath), null);
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot }).code, "no_stamp");
  });
});

test("record-build-inputs.mjs brackets the build for the package it is pointed at", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const run = (...args) => execFileAsync(process.execPath, [recordScript, ...args, "--package-root", packageRoot]);
    const expected = computeBuildInputsDigest(repoRoot);
    const short = expected.digest.slice(0, 12);

    // --finish before any --begin is a wiring error, not a silent stamp.
    await assert.rejects(run("--finish"), /no pending build inputs/);
    assert.equal(readBuildInputsStamp(buildInputsStampPath(packageRoot)), null);

    const begin = await run("--begin");
    assert.match(begin.stdout, new RegExp(`^${BUILD_INPUTS_SCHEMA} begin: digest=${short} files=${INPUT_FILE_COUNT} bytes=\\d+\n$`));
    assert.equal(readBuildInputsStamp(buildInputsPendingPath(packageRoot, childBuildId)).digest, expected.digest);

    const finish = await run("--finish");
    assert.match(
      finish.stdout,
      new RegExp(`^${BUILD_INPUTS_SCHEMA} recorded: digest=${short} files=${INPUT_FILE_COUNT} bytes=\\d+ outputs=${OUTPUT_FILE_COUNT} stamp=node_modules/.cache/paperclip-runner-build-inputs.json\n$`),
    );
    const stamp = readBuildInputsStamp(buildInputsStampPath(packageRoot));
    assert.equal(stamp.digest, expected.digest);
    assert.equal(stamp.platform, process.platform);
    assert.equal(stamp.arch, process.arch);
    assert.equal(stamp.outputCount, OUTPUT_FILE_COUNT);
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot }).current, true);
    assert.equal((await stat(buildInputsStampPath(packageRoot))).isFile(), true);

    // An edit between the two phases is reported and leaves nothing behind.
    await run("--begin");
    await writeFile(path.join(packageRoot, "src", "index.ts"), "export const one = 2;\n");
    const moved = await run("--finish");
    assert.match(moved.stdout, /^paperclip\.runner-build-inputs not recorded: inputs changed while the build ran /);
    assert.equal(readBuildInputsStamp(buildInputsStampPath(packageRoot)), null);

    await assert.rejects(run(), /one of --begin or --finish is required/);
    await assert.rejects(run("--begin", "--finish"), /--finish cannot be combined with --begin/);
    await assert.rejects(
      execFileAsync(process.execPath, [recordScript, "--begin", "--bogus"]),
      /unknown argument --bogus/,
    );
  });
});

test("two builds running at once in one checkout each keep their own pending record", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const stampPath = buildInputsStampPath(packageRoot);
    const pendingDirectory = buildInputsPendingDirectory(packageRoot);
    const first = { repoRoot, packageRoot, buildId: "shell-1" };
    const second = { repoRoot, packageRoot, buildId: "shell-2" };
    const digestNow = () => computeBuildInputsDigest(repoRoot).digest;

    // Nothing changes: both builds record, in either finishing order, and the
    // second to finish does not fail for want of a record.
    beginRunnerBuild(first);
    beginRunnerBuild(second);
    assert.deepEqual((await readdir(pendingDirectory)).sort(), ["shell-1.json", "shell-2.json"]);
    assert.equal(recordRunnerBuild(first).recorded, true);
    assert.deepEqual(await readdir(pendingDirectory), ["shell-2.json"], "the first finish consumed the wrong record");
    assert.equal(readBuildInputsStamp(stampPath).digest, digestNow());
    assert.equal(recordRunnerBuild(second).recorded, true);
    assert.deepEqual(await readdir(pendingDirectory), []);
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot }).current, true);

    beginRunnerBuild(first);
    beginRunnerBuild(second);
    assert.equal(recordRunnerBuild(second).recorded, true);
    assert.equal(recordRunnerBuild(first).recorded, true);
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot }).current, true);

    // An edit lands between the two starts. The build that began before it
    // must not leave a stamp whichever of the two finishes last: a stamp means
    // every build that wrote dist read the inputs it names.
    const source = path.join(packageRoot, "src", "index.ts");
    beginRunnerBuild(first);
    await writeFile(source, "export const one = 2;\n");
    beginRunnerBuild(second);
    const staleFirst = recordRunnerBuild(first);
    assert.equal(staleFirst.recorded, false);
    assert.equal(staleFirst.code, "inputs_changed_during_build");
    assert.equal(readBuildInputsStamp(stampPath), null);
    assert.equal(recordRunnerBuild(second).recorded, true, "the build that read the edited inputs was not recorded");
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot }).current, true);

    beginRunnerBuild(first);
    await writeFile(source, "export const one = 3;\n");
    beginRunnerBuild(second);
    assert.equal(recordRunnerBuild(second).recorded, true);
    assert.equal(readBuildInputsStamp(stampPath).digest, digestNow());
    const staleLast = recordRunnerBuild(first);
    assert.equal(staleLast.recorded, false);
    assert.equal(staleLast.code, "inputs_changed_during_build");
    assert.equal(readBuildInputsStamp(stampPath), null, "a build that began before the edit left the other build's stamp standing");
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot }).code, "no_stamp");
    assert.deepEqual(await readdir(pendingDirectory), []);
  });
});

test("a build's start drops the pending records of builds that never finished, and no others", async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const pendingDirectory = buildInputsPendingDirectory(packageRoot);
    const now = new Date("2026-10-11T22:00:00.000Z");
    const age = async (buildId, ageMs) => {
      const moment = new Date(now.getTime() - ageMs);
      await utimes(buildInputsPendingPath(packageRoot, buildId), moment, moment);
    };

    // A build that failed a step yesterday, one that failed a minute ago, and
    // one still running, all left records; a new build starts.
    beginRunnerBuild({ repoRoot, packageRoot, buildId: "crashed-yesterday", now: () => now });
    await age("crashed-yesterday", PENDING_RECORD_MAX_AGE_MS + 60_000);
    beginRunnerBuild({ repoRoot, packageRoot, buildId: "crashed-just-now", now: () => now });
    await age("crashed-just-now", 60_000);
    beginRunnerBuild({ repoRoot, packageRoot, buildId: "still-running", now: () => now });
    await writeFile(path.join(pendingDirectory, "notes.txt"), "not a record\n");
    await age("still-running", 0);

    beginRunnerBuild({ repoRoot, packageRoot, buildId: "new-build", now: () => now });
    assert.deepEqual(
      (await readdir(pendingDirectory)).sort(),
      ["crashed-just-now.json", "new-build.json", "notes.txt", "still-running.json"],
      "pruning removed the wrong records",
    );

    // The running build and the new one still finish on their own records.
    assert.equal(recordRunnerBuild({ repoRoot, packageRoot, buildId: "still-running" }).recorded, true);
    assert.equal(recordRunnerBuild({ repoRoot, packageRoot, buildId: "new-build" }).recorded, true);
    // A record that fell out of the directory is simply absent.
    await rm(pendingDirectory, { recursive: true, force: true });
    beginRunnerBuild({ repoRoot, packageRoot, buildId: "after-wipe" });
    assert.deepEqual(await readdir(pendingDirectory), ["after-wipe.json"]);
  });
});

test("two chains run by separate shells at the same time both record", { skip: process.platform === "win32" }, async () => {
  await withRepo(async ({ repoRoot, packageRoot }) => {
    const pendingDirectory = buildInputsPendingDirectory(packageRoot);
    const marker = path.join(repoRoot, "release-the-chains");
    const records = () => (existsSync(pendingDirectory) ? readdirSync(pendingDirectory).sort() : []);

    const first = runChainInShell("sh", packageRoot, marker);
    await waitFor(() => records().length === 1, "the first chain's record");
    const second = runChainInShell("sh", packageRoot, marker);
    await waitFor(() => records().length === 2, "the second chain's record");
    const [firstId, secondId] = records().map((name) => name.replace(/\.json$/, ""));
    assert.notEqual(firstId, secondId);
    for (const id of [firstId, secondId]) {
      assert.match(id, /^\d+$/, "a chain's record is named after its shell's pid");
      assert.equal(readBuildInputsStamp(buildInputsPendingPath(packageRoot, id)).buildId, id);
    }

    await writeFile(marker, "go\n");
    const results = await Promise.all([first, second]);
    for (const result of results) {
      assert.match(result.stdout, new RegExp(`${BUILD_INPUTS_SCHEMA} begin: `));
      assert.match(result.stdout, new RegExp(`${BUILD_INPUTS_SCHEMA} recorded: `), "a chain finished without recording");
    }
    assert.deepEqual(records(), []);
    assert.equal(assessRunnerBuild({ repoRoot, packageRoot }).current, true);

    // The same chain under bash, which may exec its last command: `--finish`
    // is then the shell itself and still finds the record `--begin` wrote.
    let bash;
    try {
      bash = (await execFileAsync("bash", ["-c", "echo ok"])).stdout.trim() === "ok";
    } catch {
      bash = false;
    }
    if (bash) {
      await rm(marker);
      const chain = runChainInShell("bash", packageRoot, marker);
      await waitFor(() => records().length === 1, "the bash chain's record");
      await writeFile(marker, "go\n");
      assert.match((await chain).stdout, new RegExp(`${BUILD_INPUTS_SCHEMA} recorded: `));
      assert.deepEqual(records(), []);
    }
  });
});
