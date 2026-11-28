import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { comparison, snapshot } from "../local-verify/inputs.mjs";
import { planVerification } from "../local-verify/plan.mjs";
import { fixture, repository } from "./local-verify-fixture.mjs";

test("real selected execution reuses passes and invalidates source, environment, untracked tests and broad inputs", { timeout: 180_000 }, async t => {
  const f = fixture(t);
  const first = f.run();
  assert.equal(first.status, 0, first.text);
  assert.match(first.text, /Test Files\s+1 passed/);
  assert.match(first.text, /1\/3 Vitest test files selected/);
  assert.doesNotMatch(first.text, /unrelated full-suite control/);
  const reused = f.run();
  assert.equal(reused.status, 0, reused.text);
  assert.match(reused.text, /reusing a passing local result/);
  assert.doesNotMatch(reused.text, /Test Files/);
  const last = JSON.parse(readFileSync(path.join(f.root, ".turbo/local-verify/last-run.json"), "utf8"));
  const passFile = path.join(f.root, ".turbo/local-verify", `${last.key}.json`);
  const corrupt = JSON.parse(readFileSync(passFile, "utf8"));
  corrupt.plan.selectedFiles = [];
  writeFileSync(passFile, JSON.stringify(corrupt));
  const recovered = f.run();
  assert.equal(recovered.status, 0, recovered.text);
  assert.doesNotMatch(recovered.text, /reusing a passing local result/);
  assert.match(recovered.text, /Reusing passed general-workspaces-a-reusable/);
  f.write("ui/src/leaf.ts", "export const value = 3;\n");
  const edited = f.run();
  assert.equal(edited.status, 0, edited.text);
  assert.match(edited.text, /Test Files\s+1 passed/);
  const environment = f.run([], { LOCAL_VERIFY_FLAVOR: "different" });
  assert.equal(environment.status, 0, environment.text);
  assert.match(environment.text, /Test Files\s+1 passed/);
  const environmentFailure = f.run([], { LOCAL_VERIFY_FLAVOR: "fail" });
  assert.equal(environmentFailure.status, 1, environmentFailure.text);
  assert.match(environmentFailure.text, /affected consumer/);
  const installed = readFileSync(path.join(f.root, "node_modules/.modules.yaml"), "utf8");
  f.write("node_modules/.modules.yaml", `${installed}\n# changed installation\n`);
  const dependencies = f.run();
  assert.equal(dependencies.status, 0, dependencies.text);
  assert.match(dependencies.text, /Test Files\s+1 passed/);
  rmSync(path.join(f.root, "node_modules/vitest"));
  const brokenInstall = f.run();
  assert.equal(brokenInstall.status, 2, brokenInstall.text);
  assert.doesNotMatch(brokenInstall.text, /reusing a passing local result/);
  symlinkSync(path.join(repository, "node_modules/vitest"), path.join(f.root, "node_modules/vitest"), "dir");
  f.write("ui/src/new.test.ts", 'import {test,expect} from "vitest"; test("new untracked regression",()=>expect(false).toBe(true));');
  const untracked = f.run();
  assert.equal(untracked.status, 1, untracked.text);
  assert.match(untracked.text, /new untracked regression/);
  const failedAgain = f.run();
  assert.equal(failedAgain.status, 1, failedAgain.text);
  assert.doesNotMatch(failedAgain.text, /reusing a passing local result/);
  rmSync(path.join(f.root, "ui/src/new.test.ts"));
  f.write("ui/vitest.config.mjs", 'export default {test:{name:"@paperclipai/ui",include:["src/**/*.test.ts"],testTimeout:10000}};');
  const config = f.run();
  assert.equal(config.status, 2, config.text);
  assert.match(config.text, /Broader verification required/);
  assert.doesNotMatch(config.text, /Test Files/);
  assert.match(config.text, /vitest.config.mjs/);
});

test("working tree comparison includes commits, staging, deletion, rename and untracked files", t => {
  const f = fixture(t);
  f.git("add", "ui/src/leaf.ts");
  f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "committed change");
  f.git("mv", "ui/src/other.ts", "ui/src/renamed.ts");
  rmSync(path.join(f.root, "cli/src/independent.test.ts"));
  f.write("ui/src/added.ts", "export const added = true;");
  assert.deepEqual(comparison(f.root, f.base).changed, ["cli/src/independent.test.ts", "ui/src/added.ts", "ui/src/leaf.ts", "ui/src/other.ts", "ui/src/renamed.ts"]);
  assert.throws(() => comparison(f.root, "missing-ref"), /Cannot resolve a base/);
});

test("dependency installation, ignored dotenv and child environment enter the cache fingerprint", t => {
  const f = fixture(t), before = snapshot(f.root, f.env).hash;
  f.write(".env", "FEATURE=true\n");
  assert.notEqual(snapshot(f.root, f.env).hash, before);
  rmSync(path.join(f.root, ".env"));
  assert.equal(snapshot(f.root, f.env).hash, before);
  f.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  assert.notEqual(snapshot(f.root, f.env).hash, before);
  assert.notEqual(snapshot(f.root, { ...f.env, NEW_TEST_FLAG: "1" }).hash, before);
  assert.equal(snapshot(f.root, { ...f.env, PAPERCLIP_TEST_POSTGRES_ADMIN_URL: "postgres://external.invalid/test" }).cacheable, false);
});

test("repository skill directory links preserve reuse while target edits invalidate it", t => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, ".claude/skills"), { recursive: true });
  symlinkSync("../../ui", path.join(f.root, ".claude/skills/local"), "dir");
  f.git("add", ".claude/skills/local");
  const before = snapshot(f.root, f.env);
  assert.equal(before.cacheable, true);
  f.write("ui/src/leaf.ts", "export const value = 3;\n");
  assert.notEqual(snapshot(f.root, f.env).hash, before.hash);
});

test("local chat selection schedules affected split chat suites through general-chat", { timeout: 120_000 }, async t => {
  const f = fixture(t);
  f.write("ui/src/leaf.ts", "export const value = 1;\n");
  f.write("vitest.config.mjs", 'export default {test:{projects:["server"]}};');
  f.write("server/vitest.config.mjs", 'export default {test:{name:"@paperclipai/server",include:["src/**/*.test.ts"]}};');
  f.write("server/src/leaf.ts", "export const value = 1;\n");
  f.write("server/src/__tests__/chat-channels/sample.integration.test.ts", 'import {test,expect} from "vitest"; import {value} from "../../leaf"; test("chat selection",()=>expect(value).toBeGreaterThan(0));');
  f.write("server/src/__tests__/chat-channels/unrelated.integration.test.ts", 'import {test,expect} from "vitest"; test("unrelated chat",()=>expect(1).toBe(1));');
  f.write(".github/ci-task-matrix.json", JSON.stringify({ general_tests: [
    { task: "ci:server", group: "general-server-without-chat" }, { task: "ci:chat", group: "general-chat" },
  ] }));
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "chat baseline");
  const base = f.git("rev-parse", "HEAD");
  f.write("server/src/leaf.ts", "export const value = 2;\n");
  const plan = await planVerification({ root: f.root, env: f.env, diff: comparison(f.root, base) });
  assert.equal(plan.kind, "selected", plan.reason);
  assert.deepEqual(plan.selectedFiles, ["server/src/__tests__/chat-channels/sample.integration.test.ts"]);
  assert.deepEqual(plan.manifest.lanes["general-chat"].shards, [
    { "@paperclipai/server": ["server/src/__tests__/chat-channels/sample.integration.test.ts"] },
  ]);
});

test("fingerprints preserve file boundaries when content resembles another input record", t => {
  const f = fixture(t), a = "ui/src/hash-a.ts", b = "ui/src/hash-b.ts";
  f.write(a, ""); f.write(b, "tail");
  const boundary = JSON.stringify(b) + String(lstatSync(path.join(f.root, b)).mode);
  f.write(a, `${boundary}payload`);
  const first = snapshot(f.root, f.env).hash;
  f.write(a, ""); f.write(b, `payload${boundary}tail`);
  assert.notEqual(snapshot(f.root, f.env).hash, first);
});

test("documentation-only changes and empty diffs do not start a full suite", async t => {
  const f = fixture(t);
  f.write("ui/src/leaf.ts", "export const value = 1;\n");
  f.write("doc/DEVELOPING.md", "Guidance only\n");
  const result = f.run(["--explain"]);
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /0 Vitest test files selected/);
  assert.doesNotMatch(result.text, /Test Files/);
  const plan = await planVerification({ root: f.root, env: f.env,
    diff: { ...comparison(f.root, f.base), changed: [] } });
  assert.deepEqual(plan.jobs, []);
});
