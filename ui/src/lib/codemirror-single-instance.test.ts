import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// CodeMirror validates extensions with instanceof, so the dependency graph
// must resolve exactly one copy of these packages. Two resolved versions
// ship two module instances and crash the editor at runtime with
// "Unrecognized extension value in extension set" — a failure no unit test
// of the editor itself catches, because each test file sees only one copy.
// The pnpm.overrides entries in the root package.json hold the graph to a
// single resolution; this test pins that invariant against the lockfile so
// a future dependency cannot silently reintroduce a second copy.
const SINGLE_INSTANCE_PACKAGES = ["@codemirror/state", "@codemirror/view"];

const lockfile = readFileSync(
  path.resolve(__dirname, "../../..", "pnpm-lock.yaml"),
  "utf8",
);

describe("codemirror single-instance invariant", () => {
  for (const pkg of SINGLE_INSTANCE_PACKAGES) {
    it(`resolves exactly one version of ${pkg}`, () => {
      // Lockfile package/snapshot keys look like '@codemirror/state@6.7.2':
      // (peer-suffixed variants append "(...)" before the closing quote).
      const versions = new Set(
        [...lockfile.matchAll(new RegExp(`'${pkg}@([^'()]+)[')(]`, "g"))].map(
          (match) => match[1],
        ),
      );
      expect(
        [...versions],
        `${pkg} must resolve to one version; multiple copies break ` +
          "instanceof checks inside the editor. Update the pnpm.overrides " +
          "entry in the root package.json instead of allowing a second copy.",
      ).toHaveLength(1);
    });
  }
});
