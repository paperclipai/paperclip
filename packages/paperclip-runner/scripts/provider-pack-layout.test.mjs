import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeProviderPackLayout, normalizeProviderPackMetadata } from "./provider-pack-layout.mjs";
import { sha256Tree } from "./provider-pack-integrity.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  writeFileSync(join(root, "dist", "cli", "provider.cjs"), "provider bytes\n");
  return root;
}

test("app and sandbox image build orders produce the same provider layout", (t) => {
  const app = fixture(t), image = fixture(t);
  mkdirSync(join(app, "dist", "bin"));
  writeFileSync(join(app, "dist", "bin", "paperclip-runnerd"), "separately verified native binary");
  normalizeProviderPackLayout(app);
  normalizeProviderPackLayout(image);
  assert.deepEqual(readdirSync(join(app, "dist")), readdirSync(join(image, "dist")));
  assert.deepEqual(readFileSync(join(app, "dist", "cli", "provider.cjs")), readFileSync(join(image, "dist", "cli", "provider.cjs")));
});

test("normalization removes only redundant runnerd and retains other bin entries", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "dist", "bin"));
  writeFileSync(join(root, "dist", "bin", "paperclip-runnerd"), "runnerd");
  writeFileSync(join(root, "dist", "bin", "future-provider"), "keep me");
  normalizeProviderPackLayout(root);
  normalizeProviderPackLayout(root);
  assert.deepEqual(readdirSync(join(root, "dist", "bin")), ["future-provider"]);
  assert.equal(readFileSync(join(root, "dist", "bin", "future-provider"), "utf8"), "keep me");
});

test("normalization never follows a substituted bin directory", (t) => {
  const root = fixture(t), outside = fixture(t);
  writeFileSync(join(outside, "paperclip-runnerd"), "keep outside bytes");
  symlinkSync(outside, join(root, "dist", "bin"));
  assert.throws(() => normalizeProviderPackLayout(root), /must be a directory/);
  assert.equal(readFileSync(join(outside, "paperclip-runnerd"), "utf8"), "keep outside bytes");
});

function metadataFixture(t, date) {
  const root = fixture(t), provider = join(root, "node_modules/.pnpm/tool@1/node_modules/tool");
  const shim = join(provider, "node_modules/.bin/tool");
  mkdirSync(dirname(shim), { recursive: true });
  mkdirSync(join(root, "runtime-extra/only-through-node-path"), { recursive: true });
  writeFileSync(join(root, "runtime-extra/only-through-node-path/index.js"), 'module.exports = "dependency resolved";');
  writeFileSync(join(provider, "cli.cjs"), 'console.log(JSON.stringify({value:require("only-through-node-path"),args:process.argv.slice(2),nodePath:process.env.NODE_PATH}));');
  writeFileSync(shim, ["#!/bin/sh", 'basedir=$(dirname "$0")',
    'if [ -z "$NODE_PATH" ]; then', `  export NODE_PATH="${root}/runtime-extra"`,
    "else", `  export NODE_PATH="${root}/runtime-extra:$NODE_PATH"`, "fi",
    'exec node "$basedir/../../cli.cjs" "$@"', ""].join("\n"), { mode: 0o755 });
  symlinkSync(".pnpm/tool@1/node_modules/tool", join(root, "node_modules/tool"));
  writeFileSync(join(root, "node_modules/.modules.yaml"), `packageManager: pnpm@9.15.4\nprunedAt: ${date}\nvirtualStoreDir: .pnpm\n`);
  return { root, shim };
}

test("independent build paths and pruning times produce identical complete content trees", (t) => {
  const a = metadataFixture(t, "Wed, 09 Sep 2026 21:44:13 GMT"), b = metadataFixture(t, "Wed, 09 Sep 2026 21:45:40 GMT");
  assert.notEqual(sha256Tree(a.root), sha256Tree(b.root));
  for (const pack of [a, b]) assert.equal(normalizeProviderPackMetadata(pack.root).normalizedShims, 1);
  assert.equal(sha256Tree(a.root), sha256Tree(b.root));
  const before = sha256Tree(a.root);
  assert.equal(normalizeProviderPackMetadata(a.root).normalizedShims, 0);
  assert.equal(sha256Tree(a.root), before);
});

test("normalized nested launcher resolves dependencies and arguments after relocation and symlink invocation", (t) => {
  const pack = metadataFixture(t, "Wed, 09 Sep 2026 21:44:13 GMT");
  normalizeProviderPackMetadata(pack.root);
  const parent = mkdtempSync(join(tmpdir(), "provider move ' "));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const moved = join(parent, "moved pack"); renameSync(pack.root, moved);
  const logical = join(moved, "node_modules/tool/node_modules/.bin/tool");
  symlinkSync(logical, join(parent, "absolute")); symlinkSync("absolute", join(parent, "relative"));
  for (const existing of [undefined, "/existing caller path"]) {
    const env = { ...process.env, PATH: dirname(process.execPath) + ":" + process.env.PATH };
    if (existing === undefined) delete env.NODE_PATH; else env.NODE_PATH = existing;
    for (const command of [logical, join(parent, "absolute"), join(parent, "relative")]) {
      const result = JSON.parse(execFileSync(command, ["argument with spaces", "'quoted'"], { cwd: "/", encoding: "utf8", env }));
      assert.equal(result.value, "dependency resolved");
      assert.deepEqual(result.args, ["argument with spaces", "'quoted'"]);
      assert.equal(result.nodePath, join(realpathSync(moved), "runtime-extra") + (existing ? ":" + existing : ""));
      assert(!result.nodePath.includes(pack.root));
    }
  }
});

test("metadata normalization rejects substituted node_modules and bookkeeping links", (t) => {
  const root = fixture(t), outside = metadataFixture(t, "original timestamp");
  symlinkSync(join(outside.root, "node_modules"), join(root, "node_modules"));
  assert.throws(() => normalizeProviderPackMetadata(root), /physical directory/);
  assert(readFileSync(outside.shim, "utf8").includes(outside.root));
  const pack = metadataFixture(t, "original timestamp"), metadata = join(pack.root, "node_modules/.modules.yaml");
  rmSync(metadata); symlinkSync(join(outside.root, "node_modules/.modules.yaml"), metadata);
  assert.throws(() => normalizeProviderPackMetadata(pack.root), /regular file/);
  assert(readFileSync(join(outside.root, "node_modules/.modules.yaml"), "utf8").includes("original timestamp"));
});

test("unrecognized build-dependent shims fail instead of hiding unstable executable bytes", (t) => {
  const pack = metadataFixture(t, "original timestamp");
  writeFileSync(pack.shim, `#!/bin/sh\nexec "${pack.root}/somewhere"\n`);
  assert.throws(() => normalizeProviderPackMetadata(pack.root), /Unrecognized/);
});
