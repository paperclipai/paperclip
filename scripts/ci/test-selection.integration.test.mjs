import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { selectProjectTests } from "./vitest-selection-graph.mjs";
import { partitionSelection, refineTestPlan } from "./test-selection-plan.mjs";
import { selectionHash, selectedShard, validateSelection } from "./test-selection-manifest.mjs";
import { selectionEligibility } from "./select-tests.mjs";

const root = process.cwd();
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("real graph retains direct and indirect filesystem, process and opaque dependencies", async (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-vg-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "ui/src"), { recursive: true });
  mkdirSync(path.join(directory, "ui/src/glob"));
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  const write = (file, text) => writeFileSync(path.join(directory, file), text);
  write("vitest.config.mjs", 'export default {test:{projects:["ui"]}}');
  write("ui/vitest.config.mjs", `export default {resolve:{alias:{"@leaf":${JSON.stringify(path.join(directory, "ui/src/leaf.ts"))}}},test:{name:"fixture",include:["src/**/*.test.ts"],setupFiles:["./setup.ts"]}}`);
  write("ui/setup.ts", 'import "./src/environment.ts";');
  write("ui/src/environment.ts", "export const environment = true;");
  write("ui/src/leaf.ts", "export const value = 42;");
  write("ui/src/bridge.ts", 'export {value} from "@leaf";');
  write("ui/src/helper.ts", 'import {readFileSync} from "node:fs"; export const read = (file: string) => readFileSync(file, "utf8");');
  write("ui/src/import.test.ts", 'import {value} from "./bridge"; console.log(value); throw new Error("selection must not execute tests");');
  write("ui/src/reader.test.ts", 'import {readFileSync} from "node:fs"; readFileSync(new URL("./leaf.ts", import.meta.url));');
  write("ui/src/indirect.test.ts", 'import {read} from "./helper"; read("input"); throw new Error("selection must not execute tests");');
  write("ui/src/process.test.ts", 'import {execFileSync} from "node:child_process"; execFileSync("must-not-execute");');
  write("ui/src/dynamic.test.ts", 'const load = (file: string) => import(file);');
  write("ui/src/cjs.test.ts", 'const load = require;');
  write("ui/src/builtin-loader.test.ts", 'process.getBuiltinModule("fs").readFileSync("input");');
  write("ui/src/opaque.test.ts", 'import {parse} from "yaml"; console.log(parse("value: true"));');
  write("ui/src/independent.test.ts", 'export const independent = true;');
  write("ui/src/mocked.test.ts", 'import {vi} from "vitest"; vi.mock("./helper",()=>({read:()=>"mock"})); import {read} from "./helper"; read("input");');
  write("ui/src/partial.test.ts", 'import {vi} from "vitest"; vi.mock("./helper",async (original)=>await original()); import {read} from "./helper"; read("input");');
  write("ui/src/automock.test.ts", 'import {vi} from "vitest"; vi.mock("./helper"); import {read} from "./helper"; read("input");');
  write("ui/src/bypass.test.ts", 'import {vi} from "vitest"; vi.mock("./helper",()=>({read:()=>"mock"})); await vi.importActual("./helper");');
  write("ui/src/spy.test.ts", 'import {vi} from "vitest"; vi.mock("./helper",{spy:true}); import {read} from "./helper"; read("input");');
  write("ui/src/remock.test.ts", 'import {vi} from "vitest"; vi.mock("./helper",()=>({read:()=>"mock"})); vi.doMock("./helper",async original=>await original());');
  write("ui/src/arguments.test.ts", 'import {vi} from "vitest"; vi.mock("./helper",function(){return arguments[0]();});');
  write("ui/src/glob/one.ts", "export const value = 1;");
  write("ui/src/globber.ts", 'export const modules = import.meta.glob("./glob/*.ts", {eager:true});');
  write("ui/src/glob.test.ts", 'import {modules} from "./globber"; console.log(modules);');
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  const select = (changed) => selectProjectTests({ root: directory, project: "fixture", changed });
  const result = await select(["ui/src/leaf.ts"]);
  assert.deepEqual(result.related, ["ui/src/import.test.ts"]);
  for (const file of ["reader", "indirect", "process", "dynamic", "cjs", "builtin-loader", "opaque", "partial", "automock", "bypass", "spy", "remock", "arguments"]) {
    assert.ok(result.alwaysRun.includes(`ui/src/${file}.test.ts`), `${file} must never be dropped`);
  }
  assert.ok(!result.selected.includes("ui/src/independent.test.ts"));
  assert.ok(!result.alwaysRun.includes("ui/src/mocked.test.ts"), "a completely replaced local dependency performs no real IO");
  assert.ok(!result.alwaysRun.includes("ui/src/glob.test.ts"), "literal Vite globs use the real dependency graph");
  assert.ok((await select(["ui/src/glob/one.ts"])).related.includes("ui/src/glob.test.ts"));
  write("ui/src/glob/two.ts", "export const value = 2;");
  execFileSync("git", ["add", "."], { cwd: directory });
  assert.ok((await select(["ui/src/glob/two.ts"])).related.includes("ui/src/glob.test.ts"), "new glob members cannot be omitted");
  const setup = await select(["ui/src/environment.ts"]);
  assert.equal(setup.setupChanged, true);
  assert.deepEqual(setup.selected, setup.inventory, "transitive setup edits affect every test");
  write("ui/src/broken.test.ts", 'import "./missing";');
  const broken = await select(["ui/src/leaf.ts"]);
  assert.ok(broken.selected.includes("ui/src/broken.test.ts"), "an unresolved dependency must retain its test");
  write("ui/src/generated.ts", "export const generated = 42;");
  write("ui/src/generated.test.ts", 'import {generated} from "./generated"; console.log(generated);');
  execFileSync("git", ["add", "ui/src/generated.test.ts"], { cwd: directory });
  assert.ok((await select(["ui/src/leaf.ts"])).alwaysRun.includes("ui/src/generated.test.ts"),
    "generated inputs have no trustworthy source-to-output graph and retain their consumers");
  write("ui/src/environment.ts", 'import {readFileSync} from "node:fs"; readFileSync(new URL("./leaf.ts", import.meta.url));');
  await assert.rejects(select(["ui/src/leaf.ts"]), /Opaque setup builtin/, "setup filesystem reads can affect every test outside the import graph");
  mkdirSync(path.join(directory, "server/src/__tests__/helpers"), { recursive: true });
  for (const file of ["server/src/__tests__/setup-supertest.ts", "server/src/__tests__/helpers/isolated-test-home.ts"]) {
    write(file, readFileSync(path.join(root, file), "utf8"));
  }
  write("ui/setup.ts", 'import "../server/src/__tests__/setup-supertest.ts";');
  const reviewed = await select(["ui/src/leaf.ts"]);
  assert.ok(!reviewed.selected.includes("ui/src/independent.test.ts"), "reviewed isolated setup permits file selection");
  const helper = "server/src/__tests__/helpers/isolated-test-home.ts";
  const changedSetup = await select([helper]);
  assert.deepEqual(changedSetup.selected, changedSetup.inventory, "reviewed helpers still invalidate all tests when changed");
  write(helper, `${readFileSync(path.join(directory, helper), "utf8")}\n// setup edited since review\n`);
  await assert.rejects(select(["ui/src/leaf.ts"]), /Opaque setup/, "a stale review cannot authorize new setup effects");
});

test("partitioning reduces runners and preserves an exact, non-overlapping file cover", () => {
  const all = Array.from({ length: 120 }, (_, index) => `server/src/${index}.test.ts`);
  const selected = all.slice(0, 15);
  const shards = partitionSelection(all, selected, 12);
  assert.equal(shards.length, 2);
  assert.deepEqual(shards.flat().sort(), selected.sort());
  assert.equal(new Set(shards.flat()).size, selected.length);
  assert.deepEqual(partitionSelection(all, [], 12), []);
  assert.equal(partitionSelection(all, all, 12).length, 12);
  const durations = Object.fromEntries(all.map((file, index) => [file, index === 0 ? 1000 : 1]));
  assert.equal(partitionSelection(all, [all[0]], 12, durations).length, 1);
  assert.equal(partitionSelection(all, [all[0]], 12, Object.fromEntries(all.map((file) => [file, 0]))).length, 1);
});

function fixturePlan() {
  const files = ["ui/src/pages/Inbox.test.tsx", "ui/src/pages/apps/chat/chat-ui-contract.test.ts"];
  const entries = [0, 1].map((shard_index) => ({ group: "general-workspaces-a", group_label: `workspaces-a (${shard_index + 1}/2)`, shard_index, shard_count: 2, task: "ci:workspaces-a" }));
  const plan = { version: 1, mode: "enabled", forceReason: null, changed: ["ui/src/pages/Inbox.tsx"], jobs: {
    general_tests: { run: true, matrix: { include: entries }, selected: 2, total: 2 },
    verify_serialized_server: { run: false, matrix: { include: [{ task: "ci:serialized" }] } },
  } };
  const owners = { "general-workspaces-a": { "@paperclipai/ui": files } };
  const graphs = [{ project: "@paperclipai/ui", inventory: files, selected: [files[1]] }];
  return { files, ...refineTestPlan({ plan, head, owners, graphs }) };
}

test("runner consumes the exact manifest, and rejects stale, missing, or mismatched manifests", (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-vm-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { manifest, plan } = fixturePlan();
  assert.equal(plan.jobs.general_tests.selected, 1);
  const file = path.join(directory, "selection.json");
  const run = (selection = manifest, hash = selectionHash(manifest)) => {
    writeFileSync(file, JSON.stringify(selection));
    return spawnSync(process.execPath, ["scripts/run-vitest-stable.mjs", "--mode", "general", "--group", "general-workspaces-a", "--shard-index", "0", "--shard-count", "1", "--dry-run"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PAPERCLIP_CI_TEST_SELECTION: file, PAPERCLIP_CI_SELECTION_HASH: hash },
    });
  };
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).selection, manifest.lanes["general-workspaces-a"].shards[0]);
  assert.notEqual(run({ ...manifest, head: "0".repeat(40) }).status, 0);
  assert.notEqual(run(manifest, "bad-hash").status, 0);
  assert.throws(() => selectedShard(manifest, { mode: "general", group: "general-workspaces-a", shardCount: 2 }, ["@paperclipai/ui"]));
  assert.throws(() => selectedShard(manifest, { mode: "general", group: "general-workspaces-a", shardCount: 1 }, ["@paperclipai/server"]));
  const duplicate = structuredClone(manifest);
  duplicate.lanes["general-workspaces-a"].shards.push(duplicate.lanes["general-workspaces-a"].shards[0]);
  assert.throws(() => validateSelection(duplicate), /assigned twice/);
  const wrongLane = { version: 1, head, lanes: { "general-server-without-chat": {
    shards: [{ "@paperclipai/server": ["server/src/__tests__/issues-service.test.ts"] }],
  } } };
  writeFileSync(file, JSON.stringify(wrongLane));
  const misplaced = spawnSync(process.execPath, ["scripts/run-vitest-stable.mjs", "--mode", "general", "--group", "general-server-without-chat", "--shard-index", "0", "--shard-count", "1", "--dry-run"], {
    cwd: root, encoding: "utf8", env: { ...process.env, PAPERCLIP_CI_TEST_SELECTION: file, PAPERCLIP_CI_SELECTION_HASH: selectionHash(wrongLane) },
  });
  assert.notEqual(misplaced.status, 0);
  assert.match(misplaced.stderr, /belongs to another server lane/);
});

test("forced modes, config, fixtures, deletions and unknown inputs cannot narrow CI", () => {
  const plan = fixturePlan().plan;
  assert.equal(selectionEligibility(plan), null);
  for (const changed of [["ui/vitest.setup.ts"], ["ui/vite.config.ts"], ["package.json"], ["pnpm-lock.yaml"],
    ["docs/api/issues.md"], ["ui/src/missing-deleted.ts"], ["server/fixtures/input.json"], []]) {
    assert.ok(selectionEligibility({ ...plan, changed }), JSON.stringify(changed));
  }
  for (const mode of ["full", "shadow"]) assert.ok(selectionEligibility({ ...plan, mode }));
  assert.ok(selectionEligibility({ ...plan, forceReason: "full-ci" }));
});

test("the CLI publishes the complete coarse plan if setup mutates tracked inputs", (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-vd-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "ui/src"), { recursive: true });
  const file = path.join(directory, "ui/src/input.ts");
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const commit = () => git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qam", "fixture");
  git("init", "-q"); writeFileSync(file, "export const value = 1;"); git("add", "."); commit();
  const base = git("rev-parse", "HEAD");
  writeFileSync(file, "export const value = 2;"); commit();
  const merge = git("rev-parse", "HEAD");
  writeFileSync(file, "export const value = 3; // generated during setup");
  const plan = { version: 1, mode: "enabled", forceReason: null, changed: ["ui/src/input.ts"],
    jobs: { general_tests: { run: true, selected: 2, matrix: { include: [{ shard_index: 0 }, { shard_index: 1 }] } } } };
  const result = spawnSync(process.execPath, [path.join(root, "scripts/ci/select-tests.mjs")], {
    cwd: directory, encoding: "utf8", env: { ...process.env, CI_PLAN: JSON.stringify(plan), BASE_SHA: base,
      GITHUB_SHA: merge, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const fallback = JSON.parse(readFileSync(path.join(directory, ".ci-test-selection/plan.json"), "utf8"));
  assert.match(fallback.testSelectionFallback, /Source inputs changed/);
  assert.deepEqual(fallback.jobs, plan.jobs);
  assert.equal(fallback.testSelection, undefined);
});
