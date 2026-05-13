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
      "@odysseus/plugin-sdk": "2026.425.0-canary.5",
      e2b: "^2.19.0",
    },
  };
  const packageDocsByName = new Map([
    [
      "@odysseus/plugin-sdk",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, packageDocsByName),
    ["dependencies requires @odysseus/plugin-sdk@2026.425.0-canary.5, but npm does not expose that version"],
  );
});

test("collectInternalDependencyProblems accepts version-specific manifests when the root document is stale", () => {
  const manifest = {
    dependencies: {
      "@odysseus/plugin-sdk": "2026.425.0-canary.5",
    },
  };
  const packageDocsByName = new Map([
    [
      "@odysseus/plugin-sdk",
      {
        versions: {},
      },
    ],
  ]);
  const packageManifestsByKey = new Map([
    [
      createManifestLookupKey("@odysseus/plugin-sdk", "2026.425.0-canary.5"),
      { name: "@odysseus/plugin-sdk", version: "2026.425.0-canary.5" },
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
      "@odysseus/server": "^2026.430.0-canary.0",
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
      "@odysseus/browser": "2026.430.0-canary.0",
    },
  };

  assert.deepEqual(
    collectInternalDependencyProblems(manifest, new Map()),
    [
      "optionalDependencies requires @odysseus/browser@2026.430.0-canary.0, but npm publication metadata was not fetched for that dependency",
    ],
  );
});

test("verifyPackageRegistryState tolerates a stale root versions map when dist-tags and direct manifests are correct", () => {
  const packageDocsByName = new Map([
    [
      "@odysseus/ui",
      {
        "dist-tags": {
          canary: "2026.430.0-canary.0",
          latest: "2026.430.0",
        },
        versions: {},
      },
    ],
    [
      "@odysseus/shared",
      {
        versions: {},
      },
    ],
  ]);
  const packageManifestsByKey = new Map([
    [
      createManifestLookupKey("@odysseus/ui", "2026.430.0-canary.0"),
      {
        name: "@odysseus/ui",
        version: "2026.430.0-canary.0",
        dependencies: {
          "@odysseus/shared": "2026.430.0-canary.0",
        },
      },
    ],
    [
      createManifestLookupKey("@odysseus/shared", "2026.430.0-canary.0"),
      {
        name: "@odysseus/shared",
        version: "2026.430.0-canary.0",
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@odysseus/ui",
      packageDoc: packageDocsByName.get("@odysseus/ui"),
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
      "@odysseus/plugin-e2b",
      {
        "dist-tags": {
          latest: "2026.425.0-canary.5",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.425.0-canary.5": {
            dependencies: {
              "@odysseus/plugin-sdk": "2026.425.0-canary.5",
            },
          },
          "2026.427.0-canary.3": {
            dependencies: {
              "@odysseus/plugin-sdk": "2026.427.0-canary.3",
            },
          },
        },
      },
    ],
    [
      "@odysseus/plugin-sdk",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@odysseus/plugin-e2b",
      packageDoc: packageDocsByName.get("@odysseus/plugin-e2b"),
      packageDocsByName,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.427.0-canary.3",
      allowCanaryLatest: false,
    }),
    [
      "@odysseus/plugin-e2b: latest dist-tag still resolves to canary 2026.425.0-canary.5; if that state is intentional, rerun the verification script directly with --allow-canary-latest",
      "@odysseus/plugin-e2b@2026.425.0-canary.5 via latest: dependencies requires @odysseus/plugin-sdk@2026.425.0-canary.5, but npm does not expose that version",
    ],
  );
});

test("verifyPackageRegistryProblems marks canary latest drift as non-retriable", () => {
  const packageDocsByName = new Map([
    [
      "@odysseus/plugin-e2b",
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
    packageName: "@odysseus/plugin-e2b",
    packageDoc: packageDocsByName.get("@odysseus/plugin-e2b"),
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
      "odysseus",
      {
        "dist-tags": {
          latest: "2026.427.0-canary.3",
          canary: "2026.427.0-canary.3",
        },
        versions: {
          "2026.427.0-canary.3": {
            dependencies: {
              "@odysseus/server": "2026.427.0-canary.3",
            },
          },
        },
      },
    ],
    [
      "@odysseus/server",
      {
        versions: {
          "2026.427.0-canary.3": {},
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "odysseus",
      packageDoc: packageDocsByName.get("odysseus"),
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
      "@odysseus/ui",
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
      createManifestLookupKey("@odysseus/ui", "2026.430.0-canary.0"),
      {
        name: "@odysseus/ui",
        version: "2026.430.0-canary.0",
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@odysseus/ui",
      packageDoc: packageDocsByName.get("@odysseus/ui"),
      packageDocsByName,
      packageManifestsByKey,
      channel: "canary",
      distTag: "canary",
      targetVersion: "2026.430.0-canary.0",
      allowCanaryLatest: false,
    }),
    ["@odysseus/ui: dist-tag canary resolves to 2026.429.0-canary.2, expected 2026.430.0-canary.0"],
  );
});

test("verifyPackageRegistryState ignores internal peer dependency ranges", () => {
  const packageDocsByName = new Map([
    [
      "@odysseus/plugin-sdk",
      {
        "dist-tags": {
          canary: "2026.430.0-canary.0",
        },
        versions: {
          "2026.430.0-canary.0": {
            peerDependencies: {
              "@odysseus/server": "^2026.430.0-canary.0",
            },
          },
        },
      },
    ],
  ]);

  assert.deepEqual(
    verifyPackageRegistryState({
      packageName: "@odysseus/plugin-sdk",
      packageDoc: packageDocsByName.get("@odysseus/plugin-sdk"),
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
      fetchRegistryJson(new URL("https://registry.npmjs.org/@odysseus%2Fui"), { timeoutMs: 1 }),
      /timed out/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
