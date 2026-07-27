import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNpmViewFailure,
  collectReleasePackagesForChangedPaths,
  getBaseReleaseState,
  validateReleaseBootstrap,
} from "./check-release-package-bootstrap.mjs";

test("manifest changes without base state validate all release-enabled packages", () => {
  const releasePackages = [
    { dir: "packages/a", name: "@paperclipai/a", publishFromCi: true },
    { dir: "packages/b", name: "@paperclipai/b", publishFromCi: true },
    { dir: "packages/c", name: "@paperclipai/c", publishFromCi: false },
  ];

  const changedPackages = collectReleasePackagesForChangedPaths(
    ["scripts/release-package-manifest.json"],
    releasePackages,
  );

  assert.deepEqual(
    changedPackages.map((pkg) => pkg.name),
    ["@paperclipai/a", "@paperclipai/b"],
  );
  assert.deepEqual(
    changedPackages.map((pkg) => pkg.newlyReleaseEnabled),
    [true, true],
  );
});

test("manifest changes only validate newly release-enabled packages relative to base state", () => {
  const releasePackages = [
    { dir: "packages/a", name: "@paperclipai/a", publishFromCi: true },
    { dir: "packages/b", name: "@paperclipai/b", publishFromCi: true },
    { dir: "packages/c", name: "@paperclipai/c", publishFromCi: false },
  ];
  const baseReleaseState = {
    source: "manifest",
    byDir: new Map([["packages/a", { name: "@paperclipai/a", publishFromCi: true }]]),
  };

  const changedPackages = collectReleasePackagesForChangedPaths(
    ["scripts/release-package-manifest.json"],
    releasePackages,
    baseReleaseState,
  );

  assert.deepEqual(
    changedPackages.map((pkg) => pkg.name),
    ["@paperclipai/b"],
  );
  assert.deepEqual(changedPackages.map((pkg) => pkg.newlyReleaseEnabled), [true]);
});

test("package-specific changes only validate affected release-enabled packages", () => {
  const releasePackages = [
    { dir: "packages/a", name: "@paperclipai/a", publishFromCi: true },
    { dir: "packages/b", name: "@paperclipai/b", publishFromCi: true },
  ];

  const changedPackages = collectReleasePackagesForChangedPaths(
    ["packages/b/package.json", "README.md"],
    releasePackages,
  );

  assert.deepEqual(
    changedPackages.map((pkg) => pkg.name),
    ["@paperclipai/b"],
  );
  assert.deepEqual(changedPackages.map((pkg) => pkg.newlyReleaseEnabled), [false]);
});

test("npm E404 failures are treated as missing packages", () => {
  assert.equal(classifyNpmViewFailure("npm error code E404"), "missing");
  assert.equal(classifyNpmViewFailure("404 Not Found"), "missing");
});

test("non-404 npm failures are treated as registry errors", () => {
  assert.equal(classifyNpmViewFailure("npm error code EAI_AGAIN"), "registry_error");
  assert.equal(classifyNpmViewFailure("npm error code E429"), "registry_error");
});

test("base release state falls back to public packages when manifest is absent", () => {
  const releasePackages = [
    { dir: "packages/a", name: "@paperclipai/a", publishFromCi: true },
    { dir: "packages/b", name: "@paperclipai/b", publishFromCi: true },
  ];

  const baseReleaseState = getBaseReleaseState("base-sha", releasePackages, (_revision, filePath) => {
    if (filePath === "scripts/release-package-manifest.json") {
      return null;
    }

    if (filePath === "packages/a/package.json") {
      return JSON.stringify({ name: "@paperclipai/a", private: false });
    }

    if (filePath === "packages/b/package.json") {
      return JSON.stringify({ name: "@paperclipai/b", private: true });
    }

    return null;
  });

  assert.equal(baseReleaseState?.source, "public-packages");
  assert.deepEqual([...baseReleaseState.byDir.entries()], [
    ["packages/a", { name: "@paperclipai/a", publishFromCi: true }],
  ]);
});

test("newly release-enabled missing packages warn instead of failing", () => {
  const warnings = validateReleaseBootstrap(
    [{ dir: "packages/new", name: "@paperclipai/new", newlyReleaseEnabled: true }],
    () => ({ status: "missing" }),
  );

  assert.deepEqual(warnings, [
    "@paperclipai/new (packages/new) is newly release-enabled but does not exist on npm yet; the first publish will bootstrap it after merge",
  ]);
});

test("already release-enabled missing packages still fail", () => {
  assert.throws(
    () =>
      validateReleaseBootstrap(
        [{ dir: "packages/existing", name: "@paperclipai/existing", newlyReleaseEnabled: false }],
        () => ({ status: "missing" }),
      ),
    /release package bootstrap check failed:.*@paperclipai\/existing/s,
  );
});

test("registry errors still fail", () => {
  assert.throws(
    () =>
      validateReleaseBootstrap(
        [{ dir: "packages/new", name: "@paperclipai/new", newlyReleaseEnabled: true }],
        () => ({ status: "registry_error", detail: "npm error code EAI_AGAIN" }),
      ),
    /release package bootstrap check could not verify npm state:.*EAI_AGAIN/s,
  );
});
