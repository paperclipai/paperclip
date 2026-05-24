import assert from "node:assert/strict";
import test from "node:test";

import {
  collectInternalDependencyProblems,
  createManifestLookupKey,
  fetchRegistryJson,
  isCanaryVersion,
  verifyPackageRegistryProblems,
  verifyPackageRegistryState,
} from "./verify-release-registry-state.mjs";

test("isCanaryVersion matches release canaries", () => {
  assert.equal(isCanaryVersion("2026.427.0-canary.3"), true);
  assert.equal(isCanaryVersion("2026.427.0"), false);
});

test("collectInternalDependencyProblems flags missing internal versions", () => {
  const manifest = {
    dependencies: {
      "@valadrien-os/plugin-sdk": "2026.425.0-canary.5",
      e2b: "^2.19.0",
    },
  };
  const packageDocsByName = new Map([
    [
      "@valadrien-os/plugin-sdk",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, packageDocsByName),
    ["dependencies requires @valadrien-os/plugin-sdk@2026.425.0-canary.5, but npm does not expose that version"],
  );
});

test("collectInternalDependencyProblems accepts version-specific manifests when the root document is stale", () => {
  const manifest = {
    dependencies: {
      "@valadrien-os/plugin-sdk": "2026.425.0-canary.5",
    },
  };
  const packageDocsByName = new Map([
    [
      "@valadrien-os/plugin-sdk",
      {
        versions: {},
      },
    ],
  ]);
  const packageManifestsByKey = new Map([
    [
      createManifestLookupKey("@valadrien-os/plugin-sdk", "2026.425.0-canary.5"),
      { name: "@valadrien-os/plugin-sdk", version: "2026.425.0-canary.5" },
    ],
  ]);

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, packageDocsByName, packageManifestsByKey),
    [],
  );
});

test("collectInternalDependencyProblems ignores peer dependency range specifiers", () => {
  const manifest = {
    peerDependencies: {
      "@valadrien-os/server": "^2026.430.0-canary.0",
    },
  };

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, new Map()),
    [],
  );
});

test("collectInternalDependencyProblems reports unfetched transitive dependency metadata neutrally", () => {
  const manifest = {
    optionalDependencies: {
      "@valadrien-os/browser": "2026.430.0-canary.0",
    },
  };

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, new Map()),
    [
      "optionalDependencies requires @valadrien-os/browser@2026.430.0-canary.0, but npm publication metadata was not fetched for that dependency",
    ],
  );
});

test("verifyPackageRegistryState tolerates a stale root versions map when dist-tags and direct manifests are correct", () => {
  const packageDocsByName = new Map([
    [
      "@valadrien-os/ui",
      {
        "dist-tags": {
          canary: "2026.430.0-canary.0",
          latest: "2026.430.0",
        },
        versions: {},
      },
    ],
    [
      "@valadrien-os/shared",
      {
        versions: {},
      },
    ],
  ]);
  const packageManifestsByKey = new Map([
    [
      createManifestLookupKey("@valadrien-os/ui", "2026.430.0-canary.0"),
      {
        name: "@valadrien-os/ui",
        version: "2026.430.0-canary.0",
        dependencies: {
          "@valadrien-os/shared": "2026.430.0-canary.0",
        },
      },
    ],
    [
      createManifestLookupKey("@valadrien-os/shared", "2026.430.0-canary.0"),
      {
        name: "@valadrien-os/shared",
        version: "2026.430.0-canary.0",
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@valadrien-os/ui",
      packageDoc: packageDocsByName.get("@valadrien-os/ui"),
      packageDocsByName,
      packageManifestsByKey,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.430.0-canary.0",
      allowCanaryLatest: false,
    }),
    [],
  );
});

test("verifyPackageRegistryState fails when canary latest is left in place by default", () => {
  const packageDocsByName = new Map([
    [
      "@valadrien-os/plugin-e2b",
      {
        "dist-tags": {
          latest: "2026.425.0-canary.5",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.425.0-canary.5": {
            dependencies: {
              "@valadrien-os/plugin-sdk": "2026.425.0-canary.5",
            },
          },
          "2026.427.0-canary.3": {
            dependencies: {
              "@valadrien-os/plugin-sdk": "2026.427.0-canary.3",
            },
          },
        },
      },
    ],
    [
      "@valadrien-os/plugin-sdk",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@valadrien-os/plugin-e2b",
      packageDoc: packageDocsByName.get("@valadrien-os/plugin-e2b"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.427.0-canary.3",
      allowCanaryLatest: false,
    }),
    [
      "@valadrien-os/plugin-e2b: latest dist-tag still resolves to canary 2026.425.0-canary.5; if that state is intentional, rerun the verification script directly with --allow-canary-latest",
      "@valadrien-os/plugin-e2b@2026.425.0-canary.5 via latest: dependencies requires @valadrien-os/plugin-sdk@2026.425.0-canary.5, but npm does not expose that version",
    ],
  );
});

test("verifyPackageRegistryProblems marks canary latest drift as non-retriable", () => {
  const packageDocsByName = new Map([
    [
      "@valadrien-os/plugin-e2b",
      {
        "dist-tags": {
          latest: "2026.425.0-canary.5",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  const problems = verifyPackageRegistryProblems({
    packageName: "@valadrien-os/plugin-e2b",
    packageDoc: packageDocsByName.get("@valadrien-os/plugin-e2b"),
    packageDocsByName,
    channel: "canary",
    distTag: "canary",
    targetVersion: "2026.427.0-canary.3",
    allowCanaryLatest: false,
  });

  assert.equal(problems[0]?.retriable, false);
  assert.match(problems[0]?.message ?? "", /latest dist-tag still resolves to canary/);
});

test("verifyPackageRegistryState allows intentional canary latest but still checks dependencies", () => {
  const packageDocsByName = new Map([
    [
      "valadrien-os",
      {
        "dist-tags": {
          latest: "2026.427.0-canary.3",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.427.0-canary.3": {
            dependencies: {
              "@valadrien-os/server": "2026.427.0-canary.3",
            },
          },
        },
      },
    ],
    [
      "@valadrien-os/server",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "valadrien-os",
      packageDoc: packageDocsByName.get("valadrien-os"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.427.0-canary.3",
      allowCanaryLatest: true,
    }),
    [],
  );
});

test("verifyPackageRegistryState still fails when the dist-tag is stale", () => {
  const packageDocsByName = new Map([
    [
      "@valadrien-os/ui",
      {
        "dist-tags": {
          canary: "2026.429.0-canary.2",
        },
        versions: {},
      },
    ],
  ]);
  const packageManifestsByKey = new Map([
    [
      createManifestLookupKey("@valadrien-os/ui", "2026.430.0-canary.0"),
      {
        name: "@valadrien-os/ui",
        version: "2026.430.0-canary.0",
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@valadrien-os/ui",
      packageDoc: packageDocsByName.get("@valadrien-os/ui"),
      packageDocsByName,
      packageManifestsByKey,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.430.0-canary.0",
      allowCanaryLatest: false,
    }),
    ["@valadrien-os/ui: dist-tag canary resolves to 2026.429.0-canary.2, expected 2026.430.0-canary.0"],
  );
});

test("verifyPackageRegistryState ignores internal peer dependency ranges", () => {
  const packageDocsByName = new Map([
    [
      "@valadrien-os/plugin-sdk",
      {
        "dist-tags": {
          canary: "2026.430.0-canary.0",
        },
        versions: {
          "2026.430.0-canary.0": {
            peerDependencies: {
              "@valadrien-os/server": "^2026.430.0-canary.0",
            },
          },
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@valadrien-os/plugin-sdk",
      packageDoc: packageDocsByName.get("@valadrien-os/plugin-sdk"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.430.0-canary.0",
      allowCanaryLatest: false,
    }),
    [],
  );
});

test("fetchRegistryJson times out hung requests", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });

  try {
    await assert.rejects(
      fetchRegistryJson(new URL("https://registry.npmjs.org/@valadrien-os%2Fui"), { timeoutMs: 1 }),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
