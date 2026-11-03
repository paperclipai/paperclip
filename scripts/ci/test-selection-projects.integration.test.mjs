import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { selectProjects } from "./select-projects.mjs";

test("parallel project graphs preserve isolation, ordering and conservative selection", async t => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "parallel-graphs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  const write = (file, source) => writeFileSync(path.join(root, file), source);
  write(".gitignore", "node_modules/\n");
  write("vitest.config.mjs", 'export default {test:{projects:["one", "two"]}}');
  for (const name of ["one", "two"]) {
    mkdirSync(path.join(root, name));
    write(`${name}/vitest.config.mjs`, `export default {resolve:{alias:{"@leaf":${JSON.stringify(path.join(root, name, "leaf.ts"))}}},test:{name:${JSON.stringify(name)},include:["*.test.ts"]}}`);
    write(`${name}/leaf.ts`, "export const value = 1;");
    write(`${name}/leaf.test.ts`, 'import {value} from "@leaf"; throw new Error("must not execute tests " + value);');
    write(`${name}/opaque.test.ts`, 'import {readFileSync} from "node:fs"; readFileSync(process.env.INPUT);');
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  const options = { root, projects: ["two", "one"], changed: ["one/leaf.ts"] };
  const serial = await selectProjects({ ...options, concurrency: 1 });
  const parallel = await selectProjects({ ...options, concurrency: 2 });
  const stable = graphs => graphs.map(({ seconds, ...graph }) => graph);
  assert.deepEqual(stable(parallel), stable(serial));
  assert.deepEqual(parallel[0].selected, ["two/opaque.test.ts"]);
  assert.deepEqual(parallel[1].selected, ["one/leaf.test.ts", "one/opaque.test.ts"]);
  await assert.rejects(selectProjects({ ...options, projects: ["missing", "one"] }), /missing/);
  await assert.rejects(selectProjects({ ...options, concurrency: 3 }), /one or two/);
});
