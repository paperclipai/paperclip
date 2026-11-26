import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withInstalledPackagePackInput } from "./lib/installed-package-pack.mjs";

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "runner-pack-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "node_modules/.pnpm/fixture/node_modules/fixture");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "pack-fixture", version: "1.0.0", ...extra }));
  return { root, source };
}

// Capture bytes, modes, and link text without following package symlinks.
async function inventory(root) {
  const entries = [];
  async function visit(relative) {
    const path = join(root, relative);
    const stat = await lstat(path);
    const entry = { path: relative, mode: stat.mode & 0o7777 };
    if (stat.isSymbolicLink()) entries.push({ ...entry, type: "link", target: await readlink(path) });
    else if (stat.isDirectory()) {
      entries.push({ ...entry, type: "directory" });
      for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    } else {
      assert.ok(stat.isFile());
      entries.push({ ...entry, type: "file", bytes: await readFile(path) });
    }
  }
  await visit("");
  return entries;
}

for (const extra of [{}, { bundleDependencies: false }, { bundleDependencies: [] },
  { bundledDependencies: false }, { bundledDependencies: [] }]) {
  test(`stages unchanged non-bundled package ${JSON.stringify(extra)}`, async t => {
    const { root, source } = await fixture(t, extra);
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules/foreign"), "must not copy");
    await writeFile(join(source, "bin.js"), "#!/usr/bin/env node\n");
    await chmod(join(source, "bin.js"), 0o755);
    await writeFile(join(source, ".npmignore"), "excluded.txt\n");
    await symlink("bin.js", join(source, "link"));
    const sourceBefore = await inventory(source);
    let staged;
    const result = await withInstalledPackagePackInput(source, root, async (input, external) => {
      staged = input;
      assert.equal(external, true);
      assert.ok(!input.includes("node_modules"));
      assert.deepEqual(await readFile(join(input, "package.json")), await readFile(join(source, "package.json")));
      assert.deepEqual(await readFile(join(input, ".npmignore")), await readFile(join(source, ".npmignore")));
      assert.equal((await lstat(join(input, "bin.js"))).mode & 0o777, 0o755);
      assert.equal(await readlink(join(input, "link")), "bin.js");
      await assert.rejects(lstat(join(input, "node_modules")), { code: "ENOENT" });
      return "tarball";
    });
    assert.equal(result, "tarball");
    assert.deepEqual(await inventory(source), sourceBefore);
    await assert.rejects(lstat(staged), { code: "ENOENT" });
    assert.equal(await readFile(join(source, "node_modules/foreign"), "utf8"), "must not copy");
  });
}

for (const extra of [{ bundleDependencies: true }, { bundleDependencies: ["dependency"] }, { bundledDependencies: true }, { bundledDependencies: ["dependency"] }]) {
  test(`preserves original bundled pack path ${JSON.stringify(extra)}`, async t => {
    const { root, source } = await fixture(t, extra);
    const before = await readdir(root);
    const sourceBefore = await inventory(source);
    assert.equal(await withInstalledPackagePackInput(source, root, async (input, external) => {
      assert.equal(input, source); assert.equal(external, false); return "unchanged";
    }), "unchanged");
    assert.deepEqual(await readdir(root), before);
    assert.deepEqual(await inventory(source), sourceBefore);
  });
}

test("removes only its staging input when packing fails", async t => {
  const { root, source } = await fixture(t);
  const sourceBefore = await inventory(source);
  let staged;
  const error = new Error("pack failed");
  await assert.rejects(withInstalledPackagePackInput(source, root, async input => {
    staged = input; throw error;
  }), value => value === error);
  await assert.rejects(lstat(staged), { code: "ENOENT" });
  assert.deepEqual(await inventory(source), sourceBefore);
});

for (const useFiles of [true, false]) {
  test(`npm preserves ${useFiles ? "files and nested .npmignore" : ".gitignore fallback"} selection and package links`, async t => {
    const { root, source } = await fixture(t, { ...(useFiles ? { files: ["lib", "bin.js"] } : {}), bin: { fixture: "bin.js" },
      devEngines: { runtime: { name: "node", version: ">=999.0.0", onFail: "error" } } });
    await mkdir(join(source, "lib"));
    await writeFile(join(source, "bin.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
    await chmod(join(source, "bin.js"), 0o755);
    await writeFile(join(source, "lib/kept.js"), "export const value = 'unchanged';\n");
    await writeFile(join(source, "lib/ignored.js"), "not published");
    if (useFiles) await writeFile(join(source, "lib/.npmignore"), "ignored.js\n");
    else await writeFile(join(source, ".gitignore"), "outside.txt\nlib/ignored.js\n");
    await writeFile(join(source, "outside.txt"), "not in files list");
    await writeFile(join(source, "LICENSE"), "fixture license\n");
    await writeFile(join(root, "private.txt"), "must not dereference");
    await symlink(join(root, "private.txt"), join(source, "lib/link"));
    const home = join(root, "home"); await mkdir(home);
    for (const name of ["user.npmrc", "global.npmrc"]) await writeFile(join(home, name), "");
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root, CI: "true",
      NPM_CONFIG_USERCONFIG: join(home, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(home, "global.npmrc"),
      NPM_CONFIG_CACHE: join(home, "cache"), NPM_CONFIG_UPDATE_NOTIFIER: "false" };
    const pack = async (input, label) => {
      const output = join(root, label); await mkdir(output);
      const rows = JSON.parse(execFileSync("npm", ["pack", input, "--ignore-scripts", "--json", "--pack-destination", output],
        { cwd: output, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 }));
      assert.equal(rows.length, 1);
      return { files: rows[0].files, archive: await readFile(join(output, rows[0].filename)) };
    };
    // Check actual archive bytes against the installed input; the failing npm
    // directory traversal itself is reproduced separately on Linux CI.
    const sourceBefore = await inventory(source);
    let input;
    const staged = await withInstalledPackagePackInput(source, root, async path => {
      input = path;
      return pack(path, "first");
    });
    assert.deepEqual(await inventory(source), sourceBefore);
    for (const file of staged.files) {
      const bytes = execFileSync("tar", ["-xzOf", "-", `package/${file.path}`],
        { input: staged.archive, timeout: 5_000, maxBuffer: 1024 * 1024 });
      assert.deepEqual(bytes, await readFile(join(source, file.path)));
    }
    assert.deepEqual(staged.files.map(file => file.path).sort(), ["LICENSE", "bin.js", "lib/kept.js", "package.json"]);
    assert.equal(staged.files.find(file => file.path === "bin.js").mode & 0o777, 0o755);
    await assert.rejects(lstat(input), { code: "ENOENT" });
    assert.equal(await readFile(join(root, "private.txt"), "utf8"), "must not dereference");
  });
}
