import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, symlinkSync, utimesSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture } from "./local-verify-fixture.mjs";

for (const [group, task, primary, directory] of [
  ["general-workspaces-b", "ci:workspaces-b", "@paperclipai/shared", "packages/shared"],
  ["general-workspaces-c", "ci:db", "@paperclipai/db", "packages/db"],
]) test(`${group} discovers and executes reusable and fresh selected partitions`, { timeout: 180_000 }, t => {
  const f = fixture(t);
  const inventory = JSON.parse(execFileSync(process.execPath, [path.join(f.root, "scripts/run-vitest-stable.mjs"),
    "--mode", "general", "--group", group, "--dry-run"], { cwd: f.root, env: f.env, encoding: "utf8" }));
  const projects = inventory.workspaceProjects.map((project, index) => {
    const folder = project === primary ? directory : `packages/fixture-${index}`;
    f.write(`${folder}/vitest.config.mjs`, `export default {test:{name:${JSON.stringify(project)},include:["src/**/*.test.ts"]}};`);
    f.write(`${folder}/src/independent.test.ts`, 'import {test,expect} from "vitest"; test("independent workspace",()=>expect(1).toBe(1));');
    return folder;
  });
  f.write("ui/src/leaf.ts", "export const value = 1;\n");
  f.write("vitest.config.mjs", `export default {test:{projects:${JSON.stringify(projects)}}};`);
  f.write(".github/ci-task-matrix.json", JSON.stringify({ general_tests: [{ task, group }] }));
  f.write(`${directory}/src/leaf.ts`, "export const value = 1;\n");
  f.write(`${directory}/src/reusable.test.ts`, 'import {test,expect} from "vitest"; import {value} from "./leaf"; test("workspace consumer",()=>expect(value).toBeGreaterThan(0));');
  f.write(`${directory}/src/fresh.test.ts`, 'import {test,expect} from "vitest"; import {readFileSync} from "node:fs"; import {value} from "./leaf"; test("fresh workspace consumer",()=>expect(readFileSync(process.env.LOCAL_VERIFY_INPUT,"utf8")).toBe(String(value)));');
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "workspace baseline");
  const base = f.git("rev-parse", "HEAD");
  f.write(`${directory}/src/leaf.ts`, "export const value = 2;\n");
  f.write(".turbo/external-input", "2");
  const env = { LOCAL_VERIFY_INPUT: path.join(f.root, ".turbo/external-input") };
  const first = f.run(["--base", base], env);
  assert.equal(first.status, 0, first.text);
  assert.equal((first.text.match(/Test Files\s+1 passed/g) ?? []).length, 2, first.text);
  const reused = f.run(["--base", base], env);
  assert.equal(reused.status, 0, reused.text);
  assert.ok(reused.text.includes(`Reusing passed ${group}-reusable`), reused.text);
  assert.equal((reused.text.match(/Test Files\s+1 passed/g) ?? []).length, 1, reused.text);
  f.write(".turbo/external-input", "changed externally");
  const changed = f.run(["--base", base], env);
  assert.equal(changed.status, 1, changed.text);
  assert.match(changed.text, /fresh workspace consumer/);
});

test("installed dependency code changes invalidate a real passing result", { timeout: 120_000 }, t => {
  const f = fixture(t);
  const installed = "node_modules/.pnpm/clsx@1.0.0/node_modules/clsx";
  f.write(`${installed}/package.json`, '{"name":"clsx","version":"1.0.0","type":"module","exports":"./index.mjs"}');
  f.write(`${installed}/index.mjs`, "export default () => 2;\n");
  symlinkSync(path.join(f.root, installed), path.join(f.root, "node_modules/clsx"), "dir");
  f.write("ui/src/consumer.test.ts", 'import {test,expect} from "vitest"; import clsx from "clsx"; import {value} from "./leaf"; test("installed dependency",()=>expect(clsx()).toBe(value));');
  const first = f.run();
  assert.equal(first.status, 0, first.text);
  const reused = f.run();
  assert.equal(reused.status, 0, reused.text);
  assert.match(reused.text, /reusing a passing local result/);
  const moduleFile = path.join(f.root, installed, "index.mjs"), original = lstatSync(moduleFile);
  f.write(`${installed}/index.mjs`, "export default () => 0;\n");
  utimesSync(moduleFile, original.atime, original.mtime);
  const changed = f.run();
  assert.equal(changed.status, 1, changed.text);
  assert.match(changed.text, /installed dependency/);
  assert.doesNotMatch(changed.text, /reusing a passing local result/);
});

test("local server selection retains native suites and serialized ownership under a CI caller", { timeout: 120_000 }, t => {
  const f = fixture(t);
  f.write("ui/src/leaf.ts", "export const value = 1;\n");
  f.write("vitest.config.mjs", 'export default {test:{projects:["server"]}};');
  f.write("server/vitest.config.mjs", 'export default {test:{name:"@paperclipai/server",include:["src/**/*.test.ts"]}};');
  f.write("server/src/leaf.ts", "export const value = 1;\n");
  const native = "server/src/services/native-runtime/plugin-runner-probe.test.ts";
  const serialized = "server/src/__tests__/authz-owner.test.ts";
  for (const [file, imported] of [[native, "../../leaf"], [serialized, "../leaf"]]) {
    f.write(file, `import {test,expect} from "vitest"; import {value} from ${JSON.stringify(imported)}; test("local owner",()=>expect(value).toBeGreaterThan(0));`);
  }
  f.write(".github/ci-task-matrix.json", JSON.stringify({
    general_tests: [{ task: "ci:server", group: "general-server-without-chat" }],
    verify_serialized_server: [{ task: "ci:serialized" }],
  }));
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "server baseline");
  const base = f.git("rev-parse", "HEAD");
  f.write("server/src/leaf.ts", "export const value = 2;\n");
  const result = f.run(["--base", base], { GITHUB_WORKFLOW: "PR" });
  assert.equal(result.status, 0, result.text);
  assert.equal((result.text.match(/Test Files\s+1 passed/g) ?? []).length, 2);
  const record = JSON.parse(readFileSync(path.join(f.root, ".turbo/local-verify/last-run.json"), "utf8"));
  assert.deepEqual(record.plan.manifest.lanes["general-server-without-chat"].shards[0]["@paperclipai/server"], [native]);
  assert.deepEqual(record.plan.manifest.lanes.serialized.shards[0]["@paperclipai/server"], [serialized]);
});
