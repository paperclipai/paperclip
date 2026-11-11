import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRunnerDependencyBoundary } from "./check-runner-dependency-boundary.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "paperclip-dependency-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["packages/adapters", "packages/plugins/examples", "server", "ui", "cli"]) await mkdir(join(root, directory), { recursive: true });
  for (const file of ["package.json", "server/package.json", "ui/package.json", "cli/package.json"]) await writeFile(join(root, file), "{}");
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

test("rejects direct, dev, optional and peer dependencies, including aliases and wrappers", async t => {
  const root = await fixture(t);
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    await writeFile(join(root, "server/package.json"), JSON.stringify({ [section]: {
      "@deepseek-ai/dsh": "1.0.0", "provider-alias": "npm:deepseek@1.0.0", "@third-party/deepseek": "1.0.0",
    } }));
    assert.equal((await checkRunnerDependencyBoundary(root)).length, 3, section);
  }
});

test("checks workspace adapter manifests and transitive lockfile packages", async t => {
  const root = await fixture(t);
  await mkdir(join(root, "packages/adapters/fixture"));
  await writeFile(join(root, "packages/adapters/fixture/package.json"), JSON.stringify({ optionalDependencies: { "deep-seek-wrapper": "1.0.0" } }));
  await writeFile(join(root, "pnpm-lock.yaml"), "packages:\n  '@deepseek-ai/dsh@1.0.0': {}\n");
  assert.equal((await checkRunnerDependencyBoundary(root)).length, 2);
});

test("existing provider model names and documentation do not add npm dependencies", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "server/package.json"), JSON.stringify({ description: "Supports a DeepSeek model in OpenCode", dependencies: { "@paperclipai/runner-sdk": "workspace:*" } }));
  await writeFile(join(root, "README.md"), "DeepSeek is an opt-in external harness.");
  assert.deepEqual(await checkRunnerDependencyBoundary(root), []);
});
