import assert from "node:assert/strict";
import test from "node:test";

import {
  collectInternalDependencyProblems,
  isCanaryVersion,
  verifyPackageRegistryState,
} from "./verify-release-registry-state.mjs";

test("isCanaryVersion matches release canaries", () => {
  assert.equal(isCanaryVersion("2026.427.0-canary.3"), true);
  assert.equal(isCanaryVersion("2026.427.0"), false);
});

test("collectInternalDependencyProblems flags missing internal versions", () => {
  const manifest = {
    dependencies: {
      "@paperclipai/plugin-sdk": "2026.425.0-canary.5",
      e2b: "^2.19.0",
    },
  };
  const packageDocsByName = new Map([
    [
      "@paperclipai/plugin-sdk",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(collectInternalDependencyProblems(manifest, packageDocsByName), [
    "dependencies requires @paperclipai/plugin-sdk@2026.425.0-canary.5, but npm does not expose that version",
  ]);
});

test("verifyPackageRegistryState fails when canary latest is left in place by default", () => {
  const packageDocsByName = new Map([
    [
      "@paperclipai/plugin-e2b",
      {
        "dist-tags": {
          latest: "2026.425.0-canary.5",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.425.0-canary.5": {
            dependencies: {
              "@paperclipai/plugin-sdk": "2026.425.0-canary.5",
            },
          },
          "2026.427.0-canary.3": {
            dependencies: {
              "@paperclipai/plugin-sdk": "2026.427.0-canary.3",
            },
          },
        },
      },
    ],
    [
      "@paperclipai/plugin-sdk",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@paperclipai/plugin-e2b",
      packageDoc: packageDocsByName.get("@paperclipai/plugin-e2b"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.427.0-canary.3",
      allowCanaryLatest: false,
    }),
    [
      "@paperclipai/plugin-e2b: latest dist-tag still resolves to canary 2026.425.0-canary.5; rerun with --allow-canary-latest only when that state is intentional",
      "@paperclipai/plugin-e2b@2026.425.0-canary.5 via latest: dependencies requires @paperclipai/plugin-sdk@2026.425.0-canary.5, but npm does not expose that version",
    ],
  );
});

test("verifyPackageRegistryState allows intentional canary latest but still checks dependencies", () => {
  const packageDocsByName = new Map([
    [
      "paperclipai",
      {
        "dist-tags": {
          latest: "2026.427.0-canary.3",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.427.0-canary.3": {
            dependencies: {
              "@paperclipai/server": "2026.427.0-canary.3",
            },
          },
        },
      },
    ],
    [
      "@paperclipai/server",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "paperclipai",
      packageDoc: packageDocsByName.get("paperclipai"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.427.0-canary.3",
      allowCanaryLatest: true,
    }),
    [],
  );
});
