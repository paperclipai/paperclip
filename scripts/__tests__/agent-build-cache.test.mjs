import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cacheRoot, cloneInto, hashFiles, pruneKind, publishEntry, readEntry, scrubSeed, seedIsScrubbed } from "../agent-build-cache.mjs";

function scratch(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-build-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, content = "x") {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

test("a seed keeps third-party crates and loses every unit of the workspace crate", t => {
  const target = path.join(scratch(t), "target");
  const bins = ["paperclip-runnerd", "fake-codex-app-server"];
  for (const profile of ["debug", "release"]) {
    const base = path.join(target, profile);
    write(path.join(base, ".fingerprint/serde-0123/lib-serde"));
    write(path.join(base, ".fingerprint/paperclip-runner-core-0123/lib-paperclip_runner_core"));
    write(path.join(base, ".fingerprint/paperclip-runner-core-4567/bin-paperclip-runnerd"));
    write(path.join(base, "deps/libserde-0123.rlib"));
    write(path.join(base, "deps/libpaperclip_runner_core-0123.rlib"));
    write(path.join(base, "deps/paperclip_runnerd-0123"));
    write(path.join(base, "deps/fake_codex_app_server-0123.d"));
    write(path.join(base, "build/ring-0123/out/lib.a"));
    write(path.join(base, "incremental/paperclip_runner_core-0123/s"));
    write(path.join(base, "paperclip-runnerd"));
    write(path.join(base, "paperclip-runnerd.d"));
    write(path.join(base, ".cargo-lock"));
  }
  write(path.join(target, "tmp/scratch"));
  write(path.join(target, "CACHEDIR.TAG"));
  assert.equal(seedIsScrubbed(target), false);
  scrubSeed(target, bins);
  assert.equal(seedIsScrubbed(target), true);
  for (const profile of ["debug", "release"]) {
    const base = path.join(target, profile);
    assert.deepEqual(readdirSync(path.join(base, ".fingerprint")), ["serde-0123"]);
    assert.deepEqual(readdirSync(path.join(base, "deps")), ["libserde-0123.rlib"]);
    assert.ok(existsSync(path.join(base, "build/ring-0123/out/lib.a")));
    assert.deepEqual(readdirSync(path.join(base, "incremental")), []);
    for (const gone of ["paperclip-runnerd", "paperclip-runnerd.d", ".cargo-lock"]) assert.equal(existsSync(path.join(base, gone)), false);
  }
  assert.equal(existsSync(path.join(target, "tmp")), false);
  assert.ok(existsSync(path.join(target, "CACHEDIR.TAG")));
});

test("entries are published whole, once, and read back only when complete", t => {
  const cache = scratch(t);
  assert.equal(readEntry(cache, "runner-dist", "k1"), null);
  assert.throws(() => publishEntry(cache, "runner-dist", "k1", () => { throw new Error("build output vanished"); }));
  assert.equal(readEntry(cache, "runner-dist", "k1"), null);
  assert.deepEqual(readdirSync(path.join(cache, "runner-dist")), []);
  assert.equal(publishEntry(cache, "runner-dist", "k1", directory => write(path.join(directory, "a"), "first"),
    { meta: { profiles: ["debug"] } }), true);
  assert.equal(publishEntry(cache, "runner-dist", "k1", directory => write(path.join(directory, "a"), "second")), false);
  const entry = readEntry(cache, "runner-dist", "k1");
  assert.equal(readFileSync(path.join(entry.directory, "a"), "utf8"), "first");
  assert.deepEqual(entry.meta.profiles, ["debug"]);
  assert.equal(publishEntry(cache, "runner-dist", "k1", directory => write(path.join(directory, "a"), "third"),
    { replace: meta => !meta.profiles.includes("release") }), true);
  assert.equal(readFileSync(path.join(readEntry(cache, "runner-dist", "k1").directory, "a"), "utf8"), "third");
  assert.equal(readEntry(cache, "other-kind", "k1"), null);
  write(path.join(cache, "runner-dist", "k2", "entry.json"), "{\"schema\":\"old\"}");
  assert.equal(readEntry(cache, "runner-dist", "k2"), null);
});

test("a clone lands whole under the destination name", t => {
  const root = scratch(t);
  write(path.join(root, "source/nested/file"), "content");
  cloneInto(path.join(root, "source"), path.join(root, "copy"));
  assert.equal(readFileSync(path.join(root, "copy/nested/file"), "utf8"), "content");
  assert.deepEqual(readdirSync(root).sort(), ["copy", "source"]);
});

test("keys depend on content and repo-relative paths, not the checkout location", t => {
  const first = scratch(t), second = scratch(t);
  for (const root of [first, second]) write(path.join(root, "runner/src/lib.rs"), "fn main() {}");
  const digest = root => hashFiles(root, ["runner/src/lib.rs", "runner/missing.rs"]).digest("hex");
  assert.equal(digest(first), digest(second));
  write(path.join(second, "runner/src/lib.rs"), "fn main() { }");
  assert.notEqual(digest(first), digest(second));
  write(path.join(second, "runner/missing.rs"), "");
  write(path.join(first, "runner/src/lib.rs"), "fn main() { }");
  assert.notEqual(digest(first), digest(second));
});

test("the cache directory follows the environment and can be turned off", () => {
  assert.equal(cacheRoot({ PAPERCLIP_AGENT_CACHE: "0" }), null);
  assert.equal(cacheRoot({ PAPERCLIP_AGENT_CACHE_DIR: "/tmp/agent-cache" }), "/tmp/agent-cache");
  assert.equal(cacheRoot({ XDG_CACHE_HOME: "/tmp/xdg" }), "/tmp/xdg/paperclip/agent-build");
});

test("pruning keeps the most recently used entries and anything in use", t => {
  const cache = scratch(t);
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const names = ["s1", "s2", "s3", "s4", ".tmp-old", ".tmp-new"];
  for (const name of names) mkdirSync(path.join(cache, "cargo-seed", name), { recursive: true });
  const age = { s1: 5 * hour, s2: 1 * hour, s3: 3 * hour, s4: 60 * 1000, ".tmp-old": 30 * hour, ".tmp-new": hour };
  for (const name of names) {
    const when = new Date(now - age[name]);
    utimesSync(path.join(cache, "cargo-seed", name), when, when);
  }
  pruneKind(cache, "cargo-seed", "s1", now);
  // Limit 2: s4 and s2 are newest; s1 is the entry just published; s3 goes.
  assert.deepEqual(readdirSync(path.join(cache, "cargo-seed")).sort(), [".tmp-new", "s1", "s2", "s4"]);
});
