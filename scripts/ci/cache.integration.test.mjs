import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executionPlan, sourceFiles } from "./execution-plan.mjs";

const repositoryRoot = new URL("../../", import.meta.url);
const turbo = process.env.PAPERCLIP_CI_TEST_TURBO ?? new URL("node_modules/.bin/turbo", repositoryRoot).pathname;

test("every cached lane maps to an existing package script with complete inputs", () => {
  const config = JSON.parse(readFileSync(new URL("turbo.json", repositoryRoot), "utf8"));
  for (const [name, definition] of Object.entries(config.tasks).filter(([, task]) => task.cache)) {
    const plan = executionPlan(config, name.slice(3), ["--shard-index", "0"]);
    const rootTask = plan.target.startsWith("//#");
    const manifest = JSON.parse(readFileSync(new URL(rootTask ? "package.json"
      : "packages/paperclip-runner/package.json", repositoryRoot), "utf8"));
    const script = plan.target.split("#")[1];
    assert.equal(typeof manifest.scripts[script], "string", plan.target);
    assert.ok(plan.config.tasks[plan.target].inputs.length > 0);
    for (const input of plan.config.tasks[plan.target].inputs) {
      const file = rootTask ? input : input.slice("$TURBO_ROOT$/".length);
      assert.ok(definition.inputs.some((glob) => path.matchesGlob(file, glob)), input);
      assert.doesNotMatch(file, /\/(?:node_modules|target|dist)\//);
    }
    assert.ok(plan.args.includes("--shard-index"));
  }
});

test("real Turbo executes existing suite scripts and invalidates source, arguments, environment and failed tasks", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-turbo-"));
  const write = (name, content) => writeFileSync(path.join(directory, name), content);
  const json = (name, value) => write(name, JSON.stringify(value));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    write(".gitignore", ".turbo/\ngenerated/\nresult.txt\ncalls.txt\n");
    mkdirSync(path.join(directory, "packages/fixture"), { recursive: true });
    json("packages/fixture/package.json", { name: "fixture", private: true });
    json("package.json", { name: "cache-proof", private: true, packageManager: "npm@10.0.0", workspaces: ["packages/*"],
      scripts: { "test:run:general": "node check.cjs" } });
    json("package-lock.json", { name: "cache-proof", lockfileVersion: 3, packages: { "": { name: "cache-proof" } } });
    const definition = { globalEnv: ["CI_TASK_CACHE_SCOPE"], tasks: {
      "//#ci:server": { inputs: ["*.txt", "check.cjs"], outputs: ["result.txt"], env: ["FLAVOR"], cache: true },
    } };
    const execution = () => executionPlan(definition, "ci:server", ["--shard-index", "0", "--shard-count", "12"], sourceFiles(directory));
    write("input[one].txt", "first");
    write("check.cjs", `const fs = require('node:fs'); fs.appendFileSync('calls.txt','call\\n'); const input=fs.readFileSync('input[one].txt','utf8'); if(input==='fail') process.exit(1); if(!process.argv.includes('general-server-without-chat')) process.exit(2); fs.writeFileSync('result.txt',input+process.env.FLAVOR);`);
    const run = (extra = {}, args = execution().args) => {
      const plan = execution();
      json("turbo.json", plan.config);
      return spawnSync(turbo, ["run", plan.target, "--cache=local:rw", "--cache-dir=.turbo/cache", "--", ...args], {
        cwd: directory, encoding: "utf8", env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", FLAVOR: "a", CI_TASK_CACHE_SCOPE: "node-24", ...extra },
      });
    };
    const calls = () => readFileSync(path.join(directory, "calls.txt"), "utf8").trim().split("\n").length;
    const pass = (extra) => { const r = run(extra); assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
    pass(); assert.equal(calls(), 1);
    rmSync(path.join(directory, "result.txt"));
    pass(); assert.equal(calls(), 1, "cached task must not execute");
    assert.equal(readFileSync(path.join(directory, "result.txt"), "utf8"), "firsta");
    write("unrelated.md", "another push");
    pass(); assert.equal(calls(), 1, "unrelated input must retain the result");
    write("input[one].txt", "second");
    pass(); assert.equal(calls(), 2, "source must invalidate checks");
    pass({ FLAVOR: "b" }); assert.equal(calls(), 3);
    pass({ FLAVOR: "b", CI_TASK_CACHE_SCOPE: "node-25" }); assert.equal(calls(), 4);
    assert.equal(run({}, [...execution().args, "--another-argument"]).status, 0);
    assert.equal(calls(), 5, "different shard arguments must not share a task result");
    write("input[one].txt", "fail");
    assert.notEqual(run().status, 0); assert.notEqual(run().status, 0);
    assert.equal(calls(), 7, "a failed task must execute on every attempt");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the task launcher bypasses cache reads and writes when execution is forced", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-turbo-forced-"));
  const write = (name, value) => writeFileSync(path.join(directory, name), value);
  const json = (name, value) => write(name, JSON.stringify(value));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    mkdirSync(path.join(directory, "scripts/ci"), { recursive: true });
    mkdirSync(path.join(directory, "bin"));
    mkdirSync(path.join(directory, "packages/fixture"), { recursive: true });
    for (const name of ["run-task.mjs", "execution-plan.mjs"]) {
      copyFileSync(new URL(`scripts/ci/${name}`, repositoryRoot), path.join(directory, "scripts/ci", name));
    }
    write(".gitignore", ".turbo/\ncalls.txt\nresult.txt\nbin/\n");
    json("packages/fixture/package.json", { name: "fixture", private: true });
    json("package.json", { name: "forced-cache-proof", private: true, packageManager: "npm@10.0.0",
      workspaces: ["packages/*"], scripts: { "test:run:general": "node check.cjs" } });
    json("package-lock.json", { name: "forced-cache-proof", lockfileVersion: 3, packages: { "": { name: "forced-cache-proof" } } });
    json("turbo.json", { globalDependencies: [], globalEnv: ["CI_TASK_CACHE_SCOPE"], tasks: {
      "//#ci:server": { inputs: ["input.txt", "check.cjs"], outputs: ["result.txt"], cache: true },
    } });
    write("input.txt", "result");
    write("check.cjs", "const fs=require('node:fs');fs.appendFileSync('calls.txt','call\\n');fs.writeFileSync('result.txt',fs.readFileSync('input.txt'));");
    write("bin/pnpm", `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args[0]==='--version'){console.log('9.15.4');}else{if(args[0]!=='exec'||args[1]!=='turbo')process.exit(2);const result=spawnSync(${JSON.stringify(turbo)},args.slice(2),{stdio:'inherit'});process.exit(result.status??1);}`);
    chmodSync(path.join(directory, "bin/pnpm"), 0o755);
    const run = force => {
      const result = spawnSync(process.execPath, [path.join(directory, "scripts/ci/run-task.mjs")], {
        cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${path.join(directory, "bin")}${path.delimiter}${process.env.PATH}`,
          CI_TASK: "ci:server", CI_TASK_ARGS: "[]", CI_TASK_DRY_RUN: "false", CI_FORCE_TASKS: String(force),
          TURBO_TOKEN: "", TURBO_TEAM: "", TURBO_TELEMETRY_DISABLED: "1" },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    const calls = () => readFileSync(path.join(directory, "calls.txt"), "utf8").trim().split("\n").length;
    const cacheFiles = () => existsSync(path.join(directory, ".turbo/cache"))
      ? readdirSync(path.join(directory, ".turbo/cache"), { recursive: true }).sort() : [];
    run(true); run(true);
    assert.equal(calls(), 2, "forced runs must execute even when a previous result exists");
    assert.deepEqual(cacheFiles(), [], "forced runs must not populate the task cache");
    run(false); run(false);
    assert.equal(calls(), 3, "ordinary runs still reuse local results");
    const retainedCache = cacheFiles();
    assert.ok(retainedCache.length > 0);
    run(true);
    assert.equal(calls(), 4, "forced runs must bypass an existing cache hit");
    assert.deepEqual(cacheFiles(), retainedCache);
    symlinkSync("input.txt", path.join(directory, "unclassified-link"));
    run(false);
    assert.equal(calls(), 5, "unclassified non-regular input must force execution");
    assert.deepEqual(cacheFiles(), retainedCache);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
