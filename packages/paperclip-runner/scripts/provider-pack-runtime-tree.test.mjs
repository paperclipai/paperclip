import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  providerPackLibc,
  removeControllerArtifactsFromProviderPack,
  removeForeignLibcPackagesFromProviderPack,
  removePnpmStoreEntries,
} from "./provider-pack-runtime-tree.mjs";

test("image and native producer packs retain identical provider outputs despite different controller artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-producers-"));
  try {
    const packs = [join(root, "image"), join(root, "native")];
    for (const pack of packs) {
      mkdirSync(join(pack, "dist", "cli"), { recursive: true });
      writeFileSync(join(pack, "dist", "cli", "acpx-runtime-sidecar.cjs"), "identical provider bridge\n");
    }
    mkdirSync(join(packs[1], "dist", "bin"));
    writeFileSync(join(packs[1], "dist", "bin", "paperclip-runnerd"), "host-specific daemon");
    mkdirSync(join(packs[1], "dist", "remote-provider-packs"));
    writeFileSync(join(packs[1], "dist", "remote-provider-packs", "prior-pack.json"), "earlier release identity");
    for (const pack of packs) {
      removeControllerArtifactsFromProviderPack(pack);
      assert.deepEqual(readdirSync(join(pack, "dist")), ["cli"]);
      assert.equal(readFileSync(join(pack, "dist", "cli", "acpx-runtime-sidecar.cjs"), "utf8"), "identical provider bridge\n");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removing an owned controller-artifact link preserves its external target", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-controller-link-"));
  try {
    const pack = join(root, "pack"), outside = join(root, "outside");
    mkdirSync(join(pack, "dist"), { recursive: true }); mkdirSync(outside);
    writeFileSync(join(outside, "preserved"), "original");
    symlinkSync(outside, join(pack, "dist", "bin"));
    removeControllerArtifactsFromProviderPack(pack);
    assert.equal(existsSync(join(pack, "dist", "bin")), false);
    assert.equal(readFileSync(join(outside, "preserved"), "utf8"), "original");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function pnpmPackage(pack, entry, name, manifest = {}) {
  const path = join(pack, "node_modules", ".pnpm", entry, "node_modules", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
  writeFileSync(join(path, "binary"), `${name}\n`);
  return path;
}

function link(pack, from, entry, name) {
  const path = join(pack, "node_modules", from, name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(relative(dirname(path), join(pack, "node_modules", ".pnpm", entry, "node_modules", name)), path);
  return path;
}

test("detects the libc of the Node copied into Linux packs only", () => {
  assert.equal(providerPackLibc("linux", () => ({ header: { glibcVersionRuntime: "2.39" } })), "glibc");
  assert.equal(providerPackLibc("linux", () => ({ header: {} })), "musl");
  assert.equal(providerPackLibc("darwin", () => { throw new Error("unused"); }), undefined);
});

test("removes packages built only for another libc and every link into them", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-libc-"));
  try {
    const pack = join(root, "pack");
    pnpmPackage(pack, "@scope+native-linux-x64@1.0.0", "@scope/native-linux-x64", { libc: ["glibc"] });
    pnpmPackage(pack, "@scope+native-linux-x64-musl@1.0.0", "@scope/native-linux-x64-musl", { libc: ["musl"] });
    pnpmPackage(pack, "tool-linux-x64-musl@1.0.0", "tool-linux-x64-musl", { libc: ["musl"] });
    pnpmPackage(pack, "tool-linux-x64@1.0.0", "tool-linux-x64");
    pnpmPackage(pack, "consumer@1.0.0", "consumer", { optionalDependencies: { "tool-linux-x64": "1.0.0", "tool-linux-x64-musl": "1.0.0" } });
    const kept = [
      link(pack, ".pnpm/consumer@1.0.0/node_modules", "tool-linux-x64@1.0.0", "tool-linux-x64"),
      link(pack, ".pnpm/node_modules", "@scope+native-linux-x64@1.0.0", "@scope/native-linux-x64"),
    ];
    const pruned = [
      link(pack, ".pnpm/consumer@1.0.0/node_modules", "tool-linux-x64-musl@1.0.0", "tool-linux-x64-musl"),
      link(pack, ".pnpm/node_modules", "@scope+native-linux-x64-musl@1.0.0", "@scope/native-linux-x64-musl"),
      link(pack, "", "@scope+native-linux-x64-musl@1.0.0", "@scope/native-linux-x64-musl"),
    ];

    assert.deepEqual(removeForeignLibcPackagesFromProviderPack(pack, "glibc"), [
      "@scope+native-linux-x64-musl@1.0.0", "tool-linux-x64-musl@1.0.0",
    ]);
    assert.deepEqual(readdirSync(join(pack, "node_modules", ".pnpm")).sort(), [
      "@scope+native-linux-x64@1.0.0", "consumer@1.0.0", "node_modules", "tool-linux-x64@1.0.0",
    ]);
    for (const path of kept) assert.equal(existsSync(join(path, "package.json")), true);
    for (const path of pruned) assert.equal(lstatExists(path), false);
    // The emptied top-level scope goes too; the shared hoisted scope keeps its glibc link.
    assert.equal(existsSync(join(pack, "node_modules", "@scope")), false);
    assert.deepEqual(readdirSync(join(pack, "node_modules", ".pnpm", "node_modules", "@scope")), ["native-linux-x64"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keeps every package when the pack has no libc or the libc matches", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-libc-noop-"));
  try {
    const pack = join(root, "pack");
    pnpmPackage(pack, "tool-linux-x64-musl@1.0.0", "tool-linux-x64-musl", { libc: ["musl"] });
    assert.deepEqual(removeForeignLibcPackagesFromProviderPack(pack, undefined), []);
    assert.deepEqual(removeForeignLibcPackagesFromProviderPack(pack, "musl"), []);
    assert.equal(existsSync(join(pack, "node_modules", ".pnpm", "tool-linux-x64-musl@1.0.0")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses store entry names that escape the pnpm virtual store", () => {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-store-escape-"));
  try {
    const pack = join(root, "pack");
    mkdirSync(join(pack, "node_modules", ".pnpm", "node_modules"), { recursive: true });
    writeFileSync(join(pack, "node_modules", "outside"), "kept");
    for (const name of ["../outside", "node_modules", "a/b"]) {
      assert.throws(() => removePnpmStoreEntries(pack, [name]), /Refusing to remove/);
    }
    assert.equal(readFileSync(join(pack, "node_modules", "outside"), "utf8"), "kept");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}
