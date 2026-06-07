import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyToPackage,
  findScopedPackageDirs,
  OVERLAY_FIELDS,
} from "./apply-publish-config.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

function makePkgDir(name, pkg) {
  const root = mkdtempSync(join(tmpdir(), "apc-"));
  const dir = join(root, "node_modules", "@paperclipai", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  return { root, dir };
}

function readDevPkg(relPath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath, "package.json"), "utf8"));
}

test("overlays publishConfig dist mappings onto a dev manifest", () => {
  const dev = readDevPkg("packages/adapter-utils");
  // Sanity: the trap exists — dev exports point at ./src.
  assert.equal(dev.exports["."], "./src/index.ts");

  const { root, dir } = makePkgDir("adapter-utils", dev);
  try {
    const r = applyToPackage(dir);
    assert.equal(r.status, "patched");

    const out = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    // Root now points at dist, matching publishConfig.
    assert.deepEqual(out.exports, dev.publishConfig.exports);
    assert.equal(out.main, dev.publishConfig.main);
    assert.equal(out.types, dev.publishConfig.types);
    // publishConfig itself is preserved; access is NOT promoted to root.
    assert.ok(out.publishConfig, "publishConfig retained");
    assert.equal(out.access, undefined, "publish-only field not promoted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output matches the hand-rescued TON-2274 snapshots", () => {
  // The rescue backup holds the known-good package.json files claude-cli
  // produced by hand. Our deterministic overlay must reproduce them.
  const snapshotDir =
    "/Volumes/Data/paperclip-backups/ton2274/rescued-install-2026-06-07/pkgjson";
  const cases = [
    ["adapter-utils", "packages/adapter-utils"],
    ["db", "packages/db"],
    ["shared", "packages/shared"],
    ["adapter-claude-local", "packages/adapters/claude-local"],
  ];
  let checked = 0;
  for (const [snapName, relPath] of cases) {
    let expected;
    try {
      expected = JSON.parse(
        readFileSync(join(snapshotDir, `${snapName}.package.json`), "utf8"),
      );
    } catch {
      continue; // snapshot not present on this host; skip
    }
    const dev = readDevPkg(relPath);
    const { root, dir } = makePkgDir(snapName, dev);
    try {
      applyToPackage(dir);
      const out = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      for (const field of OVERLAY_FIELDS) {
        assert.deepEqual(
          out[field],
          expected[field],
          `${snapName}: field ${field} should match rescued snapshot`,
        );
      }
      checked++;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // Don't silently pass if the snapshots are simply missing.
  if (checked === 0) {
    console.warn("WARN: no rescue snapshots available; snapshot parity not verified");
  }
});

test("is idempotent — second run is a no-op", () => {
  const dev = readDevPkg("packages/shared");
  const { root, dir } = makePkgDir("shared", dev);
  try {
    const first = applyToPackage(dir);
    assert.equal(first.status, "patched");
    const second = applyToPackage(dir);
    assert.equal(second.status, "ok", "re-running must not re-patch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plugin-sdk has no crash-loop trap — exports preserved, only main/types added", () => {
  // plugin-sdk is the one package whose dev exports already point at dist, so
  // it never crash-loops. The overlay must leave exports untouched and only
  // fill in the missing root main/types (matching npm pack-time behavior).
  const dev = readDevPkg("packages/plugins/sdk");
  assert.equal(dev.exports["."].import, "./dist/index.js");
  const { root, dir } = makePkgDir("plugin-sdk", dev);
  try {
    applyToPackage(dir);
    const out = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.deepEqual(out.exports, dev.exports, "exports must be unchanged");
    assert.equal(out.main, dev.publishConfig.main);
    // And a second pass is a no-op.
    assert.equal(applyToPackage(dir).status, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("never writes through a symlinked package dir (workspace-source safety)", () => {
  // Reproduces the TON-2280 corruption: a tree whose node_modules/@paperclipai/*
  // entries are SYMLINKS back to editable source packages. The overlay must NOT
  // follow them and rewrite the source manifests.
  const root = mkdtempSync(join(tmpdir(), "apc-sym-"));
  try {
    // The real (editable) source package, with the dev "./src" crash-trap.
    const src = readDevPkg("packages/shared");
    const srcDir = join(root, "packages", "shared");
    mkdirSync(srcDir, { recursive: true });
    const srcManifest = join(srcDir, "package.json");
    const before = JSON.stringify(src, null, 2) + "\n";
    writeFileSync(srcManifest, before);

    // A consumer tree that symlinks the source package into its scope.
    const scope = join(root, "consumer", "node_modules", "@paperclipai");
    mkdirSync(scope, { recursive: true });
    symlinkSync(srcDir, join(scope, "shared"), "dir");

    const dirs = findScopedPackageDirs(join(root, "consumer"));
    for (const dir of dirs) applyToPackage(dir);

    // Source manifest must be byte-for-byte unchanged.
    assert.equal(readFileSync(srcManifest, "utf8"), before, "source must be untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skips non-@paperclipai packages", () => {
  const { root, dir } = makePkgDir("decoy", {
    name: "left-pad",
    exports: "./src/index.ts",
    publishConfig: { exports: "./dist/index.js" },
  });
  try {
    const r = applyToPackage(dir);
    assert.equal(r.status, "skip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
