import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { collectRunnerRuntimeDependencyRoots } from "./lib/runner-runtime-dependency-roots.mjs";

async function fixture(t, manifest) {
  const root = await mkdtemp(join(tmpdir(), "runner-runtime-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "synthetic-runner", version: "1.0.0", ...manifest }));
  return root;
}

async function install(root, name, linked = false) {
  const packageRoot = linked ? join(root, "installed", name) : join(root, "node_modules", name);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version: "1.0.88" }));
  if (linked) {
    const link = join(root, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(packageRoot, link, "dir");
  }
  return realpath(packageRoot);
}

test("collects installed root optional packages alongside required packages using concrete installed roots", async t => {
  const root = await fixture(t, { dependencies: { required: "1.0.88" }, optionalDependencies: { "@github/copilot-linux-x64": "1.0.88" } });
  const required = await install(root, "required");
  const optional = await install(root, "@github/copilot-linux-x64", true);
  const before = await readFile(join(root, "package.json"));
  assert.deepEqual(await collectRunnerRuntimeDependencyRoots(root), [
    { dependencyName: "@github/copilot-linux-x64", packageRoot: optional },
    { dependencyName: "required", packageRoot: required },
  ]);
  assert.deepEqual(await readFile(join(root, "package.json")), before);
});

test("skips genuinely absent root optional packages without suppressing required packages", async t => {
  const root = await fixture(t, { dependencies: { required: "1.0.88" }, optionalDependencies: { "@github/copilot-darwin-x64": "1.0.88" } });
  const required = await install(root, "required");
  assert.deepEqual(await collectRunnerRuntimeDependencyRoots(root), [{ dependencyName: "required", packageRoot: required }]);
});

test("treats a dangling optional package link as absent", async t => {
  const root = await fixture(t, { optionalDependencies: { optional: "1.0.88" } });
  await mkdir(join(root, "node_modules"));
  await symlink(join(root, "absent"), join(root, "node_modules/optional"), "dir");
  assert.deepEqual(await collectRunnerRuntimeDependencyRoots(root), []);
});

test("rejects a missing required root even when an optional root is installed", async t => {
  const root = await fixture(t, { dependencies: { missing: "1.0.88" }, optionalDependencies: { optional: "1.0.88" } });
  await install(root, "optional");
  await assert.rejects(collectRunnerRuntimeDependencyRoots(root), { code: "ENOENT" });
});

test("does not turn other optional-root filesystem errors into absence", async t => {
  const root = await fixture(t, { optionalDependencies: { "@scope/optional": "1.0.88" } });
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "node_modules/@scope"), "not a package directory");
  await assert.rejects(collectRunnerRuntimeDependencyRoots(root), { code: "ENOTDIR" });
});

test("does not omit a declared required root that is also listed as optional", async t => {
  const root = await fixture(t, { dependencies: { required: "1.0.88" }, optionalDependencies: { required: "1.0.88" } });
  await assert.rejects(collectRunnerRuntimeDependencyRoots(root), { code: "ENOENT" });
});
