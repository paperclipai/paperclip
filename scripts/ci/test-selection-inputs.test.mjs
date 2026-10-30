import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSync } from "oxc-parser";
import { repositoryFileInputs } from "./repository-file-inputs.mjs";
import { selectProjectTests, sourceDependencies } from "./vitest-selection-graph.mjs";
import { dependencyFingerprint, dependencyReviews } from "./reviewed-test-dependencies.mjs";

const file = "/repo/ui/src/contract.test.ts";
const analyze = source => repositoryFileInputs(file, parseSync(file, source).program);

test("data properties and erased types are not global loaders or mock bypasses", () => {
  const data = sourceDependencies(file, 'import {vi} from "vitest"; const schema = {arguments: {}, fetch: false, Function: "name"}; type Factory = Function;');
  assert.deepEqual(data.reasons, []);
  const chained = sourceDependencies(file, 'import {z} from "zod"; const schema = z.object({message:z.literal("routes require auth; fetch input")}).refine(value => true);');
  assert.deepEqual(chained.reasons, []);
  for (const source of [
    'fetch("https://example.invalid");',
    'const load = globalThis.fetch; load("https://example.invalid");',
    'const make = globalThis.Function; make("return 1");',
    'const scope = globalThis; const make = scope.Function; make("return 1");',
    'const {Function: make} = globalThis; make("return 1");',
    'const {fetch: request} = globalThis; request("https://example.invalid");',
    'import {vi as mocker} from "vitest"; mocker.mock("node:path", () => ({join: () => "/other.ts"}));',
    'import {vi} from "vitest"; vi.mock("./input", function() { return arguments[0](); });',
    'import {vi} from "vitest"; vi.importActual("./input");',
    'const result = (fetch("https://example.invalid") as unknown);',
  ]) assert.ok(sourceDependencies(file, source).reasons.length, source);
});

test("reviewed SQL builders exclude drivers and revoke approval when imported source changes", t => {
  const root = realpathSync("server/node_modules/drizzle-orm");
  const review = dependencyReviews();
  for (const entry of ["index.js", "pg-core/index.js"]) assert.equal(review(path.join(root, entry), `drizzle-orm/${entry}`), true);
  assert.equal(review(path.join(root, "postgres-js/index.js"), "drizzle-orm/postgres-js/index.js"), false);
  const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-review-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const entry = path.join(fixture, "index.js"), leaf = path.join(fixture, "leaf.js");
  writeFileSync(entry, 'export * from "./leaf.js";'); writeFileSync(leaf, 'export const value = 1;');
  const before = dependencyFingerprint(entry, fixture);
  writeFileSync(leaf, 'export const value = 2;');
  assert.notEqual(dependencyFingerprint(entry, fixture), before);
  assert.equal(dependencyReviews()(entry, "drizzle-orm/index.js"), false);
  writeFileSync(leaf, 'import "node:fs";');
  assert.throws(() => dependencyFingerprint(entry, fixture), /Unreviewed external import/);
  for (const source of ['import("./child.js");', 'require("./child.js");', 'const load = require; load("./child.js");']) {
    writeFileSync(leaf, source);
    assert.throws(() => dependencyFingerprint(entry, fixture), /Unreviewed runtime loader/);
  }
});

test("file input edges require module-relative paths and non-escaping read APIs", () => {
  for (const source of [
    'import {readFileSync as read} from "node:fs"; read(new URL("./leaf.ts", import.meta.url));',
    'import fs from "node:fs"; import path from "node:path"; const root = path.dirname(import.meta.filename); const input = path.join(root, "leaf.ts"); fs.readFileSync(input);',
    'import {promises as fs} from "node:fs"; import {fileURLToPath} from "node:url"; fs.readFile(fileURLToPath(new URL("./leaf.ts", import.meta.url)));',
  ]) {
    assert.deepEqual(analyze(source), { covered: ["fs"], inputs: ["/repo/ui/src/leaf.ts"] });
  }
  for (const source of [
    'import fs from "node:fs"; fs.readFileSync(process.env.INPUT);',
    'import {readFileSync as known} from "node:fs"; import {readFileSync as unknown} from "fs"; known(new URL("./leaf.ts", import.meta.url)); unknown(process.env.INPUT);',
    'import {readFileSync as known} from "fs"; import {readFileSync as unknown} from "node:fs"; known(new URL("./leaf.ts", import.meta.url)); unknown(process.env.INPUT);',
    'import fs from "node:fs"; fs.readFileSync("src/leaf.ts");',
    'import fs from "node:fs"; const read = fs.readFileSync; read(new URL("./leaf.ts", import.meta.url));',
    'import {readFileSync as read} from "node:fs"; function load(read) { read(new URL("./leaf.ts", import.meta.url)); }',
    'import fs from "node:fs"; const input = new URL("./leaf.ts", import.meta.url); function load(input) { fs.readFileSync(input); }',
    'import fs from "node:fs"; let input = new URL("./leaf.ts", import.meta.url); fs.readFileSync(input);',
    'import fs from "node:fs"; fs.writeFileSync(new URL("./leaf.ts", import.meta.url), "value");',
    'import fs from "node:fs"; consume(fs); fs.readFileSync(new URL("./leaf.ts", import.meta.url));',
    'import fs from "node:fs"; const URL = custom; fs.readFileSync(new URL("./leaf.ts", import.meta.url));',
    'import fs from "node:fs"; fs.promises[method](new URL("./leaf.ts", import.meta.url));',
    'import fs from "node:fs"; fs.readFileSync(new URL("https://example.invalid/source.ts"));',
    'import fs from "node:fs"; const input = new URL("./leaf.ts", import.meta.url); fs.readFileSync(input);',
    'import fs from "node:fs"; const input = new URL("./leaf.ts", import.meta.url); input.pathname = "/other.ts"; fs.readFileSync(input);',
    'import fs from "node:fs"; import path from "node:path"; path.join = custom; fs.readFileSync(path.join(__dirname,"leaf.ts"));',
    'import fs from "node:fs"; import path from "node:path"; mutate(path); fs.readFileSync(path.join(__dirname,"leaf.ts"));',
    'import fs from "node:fs"; import.meta.url = "file:///other/test.ts"; fs.readFileSync(new URL("./leaf.ts", import.meta.url));',
    'import fs from "node:fs"; const meta = import.meta; meta.url = "file:///other/test.ts"; fs.readFileSync(new URL("./leaf.ts", import.meta.url));',
  ]) assert.deepEqual(analyze(source).covered, [], source);
});

test("unchanged consumer workspaces follow cross-package imports and file inputs", async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-inputs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "dir");
  const write = (file, source) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  };
  write("vitest.config.mjs", 'export default {test:{projects:["consumer", "independent"]}}');
  for (const name of ["consumer", "independent"]) {
    write(`${name}/vitest.config.mjs`, `export default {test:{name:"${name}",include:["*.test.ts"]}}`);
    write(`${name}/unrelated.test.ts`, 'export const value = 1;');
  }
  write("producer/leaf.ts", "export const value = 1;");
  write("producer/other.ts", "export const other = 1;");
  write("consumer/import.test.ts", 'import {value} from "../producer/leaf"; console.log(value);');
  write("consumer/read.test.ts", 'import {readFileSync} from "node:fs"; readFileSync(new URL("../producer/leaf.ts",import.meta.url));');
  write("consumer/directory.test.ts", 'import {readdirSync} from "node:fs"; readdirSync(new URL("../producer/",import.meta.url));');
  write("consumer/dynamic.test.ts", 'import {readFileSync} from "node:fs"; readFileSync(process.env.INPUT);');
  write("consumer/mixed.test.ts", 'import {readFileSync as known} from "node:fs"; import {readFileSync as unknown} from "fs"; known(new URL("../producer/leaf.ts",import.meta.url)); unknown(process.env.INPUT);');
  write("consumer/helper.ts", 'import {readFileSync} from "node:fs"; export const source = readFileSync(new URL("../producer/leaf.ts",import.meta.url));');
  write("consumer/helper.test.ts", 'import {source} from "./helper"; console.log(source);');
  write("consumer/outside.test.ts", 'import {readFileSync} from "node:fs"; readFileSync(new URL("/etc/hosts",import.meta.url));');
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("add", ".");
  const select = changed => selectProjectTests({ root, project: "consumer", changed });
  const affected = await select(["producer/leaf.ts"]);
  assert.deepEqual(affected.related, ["consumer/import.test.ts"]);
  assert.deepEqual(affected.inputRelated, ["consumer/directory.test.ts", "consumer/helper.test.ts", "consumer/mixed.test.ts", "consumer/read.test.ts"]);
  assert.deepEqual(affected.alwaysRun, ["consumer/dynamic.test.ts", "consumer/mixed.test.ts", "consumer/outside.test.ts"]);
  assert.ok(!affected.selected.includes("consumer/unrelated.test.ts"));
  const other = await select(["producer/other.ts"]);
  assert.deepEqual(other.selected, ["consumer/directory.test.ts", "consumer/dynamic.test.ts", "consumer/mixed.test.ts", "consumer/outside.test.ts"]);
  const independent = await selectProjectTests({ root, project: "independent", changed: ["producer/leaf.ts"] });
  assert.deepEqual(independent.selected, [], "a project without imports or opaque inputs can drop out entirely");
  write("producer/new.ts", "export const added = true;"); git("add", ".");
  assert.ok((await select(["producer/new.ts"])).inputRelated.includes("consumer/directory.test.ts"));
  symlinkSync("leaf.ts", path.join(root, "producer/link.ts"));
  write("consumer/symlink.test.ts", 'import {readFileSync} from "node:fs"; readFileSync(new URL("../producer/link.ts",import.meta.url));');
  git("add", ".");
  assert.ok((await select(["producer/leaf.ts"])).inputRelated.includes("consumer/symlink.test.ts"));
  rmSync(path.join(root, "producer/link.ts"));
  symlinkSync("other.ts", path.join(root, "producer/link.ts"));
  assert.ok((await select(["producer/link.ts"])).inputRelated.includes("consumer/symlink.test.ts"));
  write("generated/unknown.ts", "export const generated = true;");
  write("consumer/generated.test.ts", 'import {readdirSync} from "node:fs"; readdirSync(new URL("../generated/",import.meta.url));');
  git("add", "consumer/generated.test.ts");
  assert.ok((await select(["producer/other.ts"])).alwaysRun.includes("consumer/generated.test.ts"));
});
