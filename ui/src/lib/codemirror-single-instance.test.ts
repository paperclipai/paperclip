import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// CodeMirror validates extensions with instanceof, so the dependency graph
// must resolve exactly one copy of these packages. Two resolved versions
// ship two module instances and crash the editor at runtime with
// "Unrecognized extension value in extension set" — a failure no unit test
// of the editor itself catches, because each test file sees only one copy.
// The pnpm.overrides entries in the root package.json hold the graph to a
// single resolution; this file pins that invariant.
const SINGLE_INSTANCE_PACKAGES = ["@codemirror/state", "@codemirror/view"];

const repoRoot = path.resolve(__dirname, "../../..");
const lockfile = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
const workspaceManifest = readFileSync(
  path.join(repoRoot, "pnpm-workspace.yaml"),
  "utf8",
);
const rootManifest = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as { pnpm?: { overrides?: Record<string, string> } };

// The lockfile records the overrides it was resolved with in its own
// header (everything before the importers section). A lockfile whose
// header lacks these entries is a stale snapshot from before the
// overrides existed — CI never tests against one (the pr-trusted policy
// job regenerates the lockfile from the manifests for every downstream
// job, and `Refresh Lockfile` converges master), and a local
// `pnpm install` rewrites it. Only a regenerated lockfile can prove or
// violate the single-resolution invariant, so the resolution assertion
// skips on a stale snapshot instead of reporting a false regression.
const lockfileHeader = lockfile.slice(0, lockfile.indexOf("\nimporters:"));
const lockfileHasOverrides = SINGLE_INSTANCE_PACKAGES.every((pkg) =>
  new RegExp(`^\\s+'?${pkg}'?:`, "m").test(lockfileHeader),
);

describe("codemirror single-instance invariant", () => {
  for (const pkg of SINGLE_INSTANCE_PACKAGES) {
    it(`keeps the ${pkg} override in the root manifest and its workspace mirror`, () => {
      // Removing the override is the only way a second copy can come
      // back (an override rewrites every dependent's range), so the
      // override's presence is the always-enforceable half of the
      // invariant.
      expect(
        rootManifest.pnpm?.overrides?.[pkg],
        `${pkg} must stay in pnpm.overrides (root package.json); without ` +
          "it the graph can resolve two copies and instanceof checks " +
          "inside the editor break.",
      ).toMatch(/^\^6\./);
      expect(
        workspaceManifest,
        `pnpm-workspace.yaml mirrors the pnpm.overrides block and must ` +
          `carry the same ${pkg} entry.`,
      ).toMatch(new RegExp(`^\\s+"${pkg}":`, "m"));
    });

    it.skipIf(!lockfileHasOverrides)(
      `resolves exactly one version of ${pkg}`,
      () => {
        // Lockfile package/snapshot keys look like
        // '@codemirror/state@6.7.2': (peer-suffixed variants append
        // "(...)" before the closing quote).
        const versions = new Set(
          [
            ...lockfile.matchAll(new RegExp(`'${pkg}@([^'()]+)[')(]`, "g")),
          ].map((match) => match[1]),
        );
        expect(
          [...versions],
          `${pkg} must resolve to one version; multiple copies break ` +
            "instanceof checks inside the editor. Update the " +
            "pnpm.overrides entry in the root package.json instead of " +
            "allowing a second copy.",
        ).toHaveLength(1);
      },
    );
  }
});
