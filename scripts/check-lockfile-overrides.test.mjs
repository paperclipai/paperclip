import { test } from "node:test";
import assert from "node:assert/strict";

import {
  changedKeys,
  checkLockfileOverrides,
  parseYamlScalarBlock,
  readManifestOverrides,
} from "./check-lockfile-overrides.mjs";

// The `overrides:` block as pnpm 9.15.4 actually writes it: quoted only where
// YAML forces it, followed by an unrelated top-level block.
const LOCKFILE_TEXT = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

overrides:
  rollup: '>=4.59.0'
  react: ^19.2.7
  lexical: 0.46.0
  '@lexical/react': 0.46.0

patchedDependencies:
  acpx@0.12.0:
    hash: tb5cdbd7kiiblhylbkroxfdcha
`;

const MANIFEST_TEXT = JSON.stringify({
  name: "paperclip",
  pnpm: {
    overrides: {
      rollup: ">=4.59.0",
      react: "^19.2.7",
      lexical: "0.46.0",
      "@lexical/react": "0.46.0",
    },
  },
});

test("parses a flat overrides block and stops at the next top-level key", () => {
  assert.deepEqual(parseYamlScalarBlock(LOCKFILE_TEXT, "overrides"), {
    rollup: ">=4.59.0",
    react: "^19.2.7",
    lexical: "0.46.0",
    "@lexical/react": "0.46.0",
  });
});

test("returns null when the block is absent, {} when it is empty", () => {
  assert.equal(parseYamlScalarBlock("lockfileVersion: '9.0'\n", "overrides"), null);
  assert.deepEqual(parseYamlScalarBlock("overrides:\n\nimporters:\n  .:\n", "overrides"), {});
});

test("skips comments and ignores an `overrides:` key that is not top-level", () => {
  const text = "overrides:\n  # pinned for CVE-2026-1\n  rollup: '>=4.59.0'\n";
  assert.deepEqual(parseYamlScalarBlock(text, "overrides"), { rollup: ">=4.59.0" });
  assert.equal(parseYamlScalarBlock("settings:\n  overrides:\n    react: 1\n", "overrides"), null);
});

test("throws rather than mis-parsing a nested value", () => {
  assert.throws(
    () => parseYamlScalarBlock("overrides:\n  react:\n    version: 19\n", "overrides"),
    /unsupported/i,
  );
});

test("reads overrides from package.json, with pnpm-workspace.yaml taking precedence", () => {
  assert.deepEqual(
    readManifestOverrides({ packageJsonText: MANIFEST_TEXT, workspaceYamlText: null }),
    { rollup: ">=4.59.0", react: "^19.2.7", lexical: "0.46.0", "@lexical/react": "0.46.0" },
  );

  // pnpm 10 moves the field into pnpm-workspace.yaml; the guard must not go blind.
  const merged = readManifestOverrides({
    packageJsonText: JSON.stringify({ pnpm: { overrides: { react: "^18.0.0" } } }),
    workspaceYamlText: "packages:\n  - server\n\noverrides:\n  react: ^19.2.7\n  lexical: 0.46.0\n",
  });
  assert.deepEqual(merged, { react: "^19.2.7", lexical: "0.46.0" });
});

test("changedKeys reports changed, added and removed keys", () => {
  assert.deepEqual(changedKeys({ a: "1", b: "1" }, { a: "1", b: "2" }), ["b"]);
  assert.deepEqual(changedKeys({}, { a: "1" }), ["a"]);
  assert.deepEqual(changedKeys({ a: "1" }, {}), ["a"]);
});

test("passes when the committed lockfile agrees with the manifest", () => {
  const result = checkLockfileOverrides({
    lockOverrides: parseYamlScalarBlock(LOCKFILE_TEXT, "overrides"),
    manifestOverrides: readManifestOverrides({ packageJsonText: MANIFEST_TEXT, workspaceYamlText: null }),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.problems, []);
});

// The regression this guard exists for: #10299 bumped lexical in the lockfile
// and in ui/package.json but left the root override at 0.46.0, and was green in
// every job because it touched a manifest.
test("fails on the a90f816c8 shape: lockfile bumped, root override left behind", () => {
  const base = { rollup: ">=4.59.0", lexical: "0.46.0" };
  const result = checkLockfileOverrides({
    lockOverrides: { rollup: ">=4.59.0", lexical: "0.48.0" },
    manifestOverrides: base,
    baseLockOverrides: base,
    baseManifestOverrides: base,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.problems, [{ key: "lexical", lock: "0.48.0", manifest: "0.46.0" }]);
});

// The heal PR (#10391 / 20b98379a) regenerated the lockfile back to 0.46.0.
test("passes on the 20b98379a shape: refreshed lockfile back in agreement", () => {
  const base = { rollup: ">=4.59.0", lexical: "0.46.0" };
  const result = checkLockfileOverrides({
    lockOverrides: base,
    manifestOverrides: base,
    baseLockOverrides: { rollup: ">=4.59.0", lexical: "0.48.0" },
    baseManifestOverrides: base,
  });
  assert.equal(result.passed, true);
});

test("reports but does not fail a mismatch inherited unchanged from the base commit", () => {
  const broken = { lexical: "0.48.0" };
  const manifest = { lexical: "0.46.0" };
  const result = checkLockfileOverrides({
    lockOverrides: broken,
    manifestOverrides: manifest,
    baseLockOverrides: broken,
    baseManifestOverrides: manifest,
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.preExisting, [{ key: "lexical", lock: "0.48.0", manifest: "0.46.0" }]);
});

test("allows a manifest-only override change, since contributors must not commit the lockfile", () => {
  const result = checkLockfileOverrides({
    lockOverrides: { react: "^19.2.7" },
    manifestOverrides: { react: "^19.3.0" },
    baseLockOverrides: { react: "^19.2.7" },
    baseManifestOverrides: { react: "^19.2.7" },
  });
  assert.equal(result.passed, true);
});

test("still fails when a PR moves both sides to versions that disagree", () => {
  const result = checkLockfileOverrides({
    lockOverrides: { lexical: "0.48.0" },
    manifestOverrides: { lexical: "0.47.0" },
    baseLockOverrides: { lexical: "0.46.0" },
    baseManifestOverrides: { lexical: "0.46.0" },
  });
  assert.equal(result.passed, false);
  assert.equal(result.problems[0].key, "lexical");
});

test("fails when the lockfile drops an override the manifest still declares", () => {
  const base = { lexical: "0.46.0" };
  const result = checkLockfileOverrides({
    lockOverrides: {},
    manifestOverrides: base,
    baseLockOverrides: base,
    baseManifestOverrides: base,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.problems, [{ key: "lexical", lock: null, manifest: "0.46.0" }]);
});

test("fails when the lockfile gains an override the manifest never declared", () => {
  const result = checkLockfileOverrides({
    lockOverrides: { lexical: "0.46.0" },
    manifestOverrides: {},
    baseLockOverrides: {},
    baseManifestOverrides: {},
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.problems, [{ key: "lexical", lock: "0.46.0", manifest: null }]);
});

// Adding an override to the manifest without the lockfile is the sanctioned
// contributor flow — `Block manual lockfile edits` forbids committing the
// lockfile, and CI regenerates it. The guard must not block that.
test("allows a newly added manifest override with an untouched lockfile", () => {
  const result = checkLockfileOverrides({
    lockOverrides: {},
    manifestOverrides: { lexical: "0.46.0" },
    baseLockOverrides: {},
    baseManifestOverrides: {},
  });
  assert.equal(result.passed, true);
});

test("without a base commit every mismatch is failed", () => {
  const result = checkLockfileOverrides({
    lockOverrides: { lexical: "0.48.0" },
    manifestOverrides: { lexical: "0.46.0" },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.preExisting, []);
});
