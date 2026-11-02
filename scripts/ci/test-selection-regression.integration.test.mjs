import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { selectProjectTests } from "./vitest-selection-graph.mjs";
import { selectionHash } from "./test-selection-manifest.mjs";

test("selected server tests can launch independent chat runner fixtures", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-nested-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifest = { version: 1,
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    lanes: { "general-server-without-chat": { shards: [{ "@paperclipai/server": [
      "server/src/__tests__/vitest-chat-shards.test.ts",
    ] }] } },
  };
  const file = path.join(directory, "selection.json");
  writeFileSync(file, JSON.stringify(manifest));
  const result = spawnSync(process.execPath, ["scripts/run-vitest-stable.mjs", "--mode", "general",
    "--group", "general-server-without-chat", "--shard-index", "0", "--shard-count", "1"], {
    encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CI: "true", PAPERCLIP_CI_PROFILE: "false",
      PAPERCLIP_CI_TEST_SELECTION: file, PAPERCLIP_CI_SELECTION_HASH: selectionHash(manifest) },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(stripVTControlCharacters(result.stdout), /Test Files\s+1 passed/);
});

test("production runner catches the filesystem regression that raw Vitest selection misses", async (t) => {
  const repo = process.cwd();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-vr-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["ui/src", "server/src/__tests__", "server/scripts"]) mkdirSync(path.join(root, directory), { recursive: true });
  symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
  const write = (file, body) => writeFileSync(path.join(root, file), body);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  write(".gitignore", "node_modules/\nselection.json\n");
  write("package.json", '{"name":"selection-regression","private":true,"type":"module"}');
  write("vitest.config.mjs", 'export default {test:{projects:["ui"]}}');
  write("ui/vitest.config.mjs", 'export default {test:{name:"@paperclipai/ui",include:["src/**/*.test.mjs"]}}');
  write("ui/src/leaf.mjs", "export const value = 42;\n");
  write("ui/src/import.test.mjs", 'import {test,expect} from "vitest"; import {value} from "./leaf.mjs"; test("value",()=>{expect(value).toBe(42); expect(process.env.PAPERCLIP_CI_TEST_SELECTION).toBeUndefined(); expect(process.env.PAPERCLIP_CI_SELECTION_HASH).toBeUndefined();});');
  write("ui/src/import.test.mjs.test.mjs", 'throw new Error("UNSELECTED_FILE: substring filters must not execute this file");');
  write("ui/src/contract.test.mjs", 'import {test,expect} from "vitest"; import {readFileSync} from "node:fs"; test("filesystem contract",()=>expect(readFileSync(new URL("./leaf.mjs",import.meta.url),"utf8")).not.toContain("FORBIDDEN_MARKER"));');
  git("init", "-q"); git("add", ".");
  const commit = () => git("-c", "user.name=CI", "-c", "user.email=ci@example.invalid", "commit", "-qam", "fixture");
  commit();
  const run = (files) => {
    const manifest = { version: 1, head: git("rev-parse", "HEAD"), lanes: {
      "general-workspaces-a": { shards: [{ "@paperclipai/ui": files }] },
    } };
    write("selection.json", JSON.stringify(manifest));
    return spawnSync(process.execPath, [path.join(repo, "scripts/run-vitest-stable.mjs"), "--mode", "general", "--group", "general-workspaces-a", "--shard-index", "0", "--shard-count", "1"], {
      cwd: root, encoding: "utf8", timeout: 60000,
      env: { ...process.env, PAPERCLIP_CI_TEST_SELECTION: path.join(root, "selection.json"),
        PAPERCLIP_CI_SELECTION_HASH: selectionHash(manifest) },
    });
  };
  const baseline = run(["ui/src/import.test.mjs", "ui/src/contract.test.mjs"]);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  const missing = run(["ui/src/leaf.mjs"]);
  assert.equal(missing.status, 1, "an existing source file is not an executable test specification");
  assert.match(missing.stdout + missing.stderr, /Selected files must match/);
  write("ui/src/leaf.mjs", `${readFileSync(path.join(root, "ui/src/leaf.mjs"), "utf8")}// FORBIDDEN_MARKER\n`);
  commit();
  const graph = await selectProjectTests({ root, project: "@paperclipai/ui", changed: ["ui/src/leaf.mjs"] });
  assert.deepEqual(graph.related, ["ui/src/import.test.mjs"]);
  const raw = run(graph.related);
  assert.equal(raw.status, 0, raw.stdout + raw.stderr);
  assert.ok(graph.selected.includes("ui/src/contract.test.mjs"));
  const guarded = run(graph.selected);
  assert.equal(guarded.status, 1, guarded.stdout + guarded.stderr);
  assert.match(guarded.stdout + guarded.stderr, /filesystem contract/);
  assert.match(guarded.stdout + guarded.stderr, /FORBIDDEN_MARKER/);
});
