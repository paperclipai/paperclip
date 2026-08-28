import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildAdapterTypeMatcher,
  loadDeclaredAdapterTypes,
  scanForAdapterTypeLiterals,
} from "./check-adapter-type-literals.mjs";

function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "adapter-literal-check-"));
  mkdirSync(join(root, "ui/src/lib"), { recursive: true });
  mkdirSync(join(root, "ui/src/components"), { recursive: true });
  mkdirSync(join(root, "packages/adapter-utils/src"), { recursive: true });
  return root;
}

test("flags quoted adapter-type literals in shared code with file and line", (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(
    join(root, "ui/src/lib/example.ts"),
    'const ok = 1;\nif (adapterType === "kimi_local") { /* bad */ }\n',
  );

  const { violations } = scanForAdapterTypeLiterals({ root, legacyBaselines: new Map() });
  assert.deepEqual(violations, [
    { file: "ui/src/lib/example.ts", line: 2, literal: "kimi_local" },
  ]);
});

test("matcher covers declared types (cursor_cloud) and convention suffixes, excludes generic names", () => {
  const matches = buildAdapterTypeMatcher(["cursor_cloud", "cursor", "http", "process", "claude_local"]);

  // Declared identity without a convention suffix is still caught.
  assert.equal(matches("cursor_cloud"), true);
  // Convention suffixes are caught even if not in the declared list yet.
  assert.equal(matches("claude_local"), true);
  assert.equal(matches("custom_acp"), true);
  assert.equal(matches("hermes_gateway"), true);
  assert.equal(matches("future_adapter_local"), true);
  // Generic-collision legacy names are never matched, even when declared.
  assert.equal(matches("cursor"), false);
  assert.equal(matches("http"), false);
  assert.equal(matches("process"), false);
  // Ordinary strings are not matched.
  assert.equal(matches("local"), false);
  assert.equal(matches("pointer"), false);
});

test("loadDeclaredAdapterTypes parses the shared constants source of truth", (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "packages/shared/src"), { recursive: true });
  writeFileSync(
    join(root, "packages/shared/src/constants.ts"),
    'export const AGENT_ADAPTER_TYPES = [\n  "process",\n  "cursor_cloud",\n  "claude_local",\n] as const;\n',
  );

  assert.deepEqual(loadDeclaredAdapterTypes(root), ["process", "cursor_cloud", "claude_local"]);
  // Missing file (plain fixture roots) degrades to the suffix pattern only.
  assert.deepEqual(loadDeclaredAdapterTypes(makeFixtureRoot()), []);
});

test("declared non-suffixed identities are flagged in shared code", (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(
    join(root, "ui/src/components/Example.tsx"),
    'const isCloud = adapterType === "cursor_cloud";\n',
  );

  const { violations } = scanForAdapterTypeLiterals({
    root,
    legacyBaselines: new Map(),
    declaredTypes: ["cursor_cloud"],
  });
  assert.deepEqual(violations, [
    { file: "ui/src/components/Example.tsx", line: 1, literal: "cursor_cloud" },
  ]);
});

test("legacy files ratchet per identity instead of being skipped", (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(
    join(root, "ui/src/components/Legacy.tsx"),
    ['const a = t === "codex_local";', 'const b = t === "claude_local";', 'const c = t === "kimi_local";'].join("\n"),
  );

  // At baseline: green.
  const atBaseline = scanForAdapterTypeLiterals({
    root,
    legacyBaselines: new Map([
      ["ui/src/components/Legacy.tsx", { codex_local: 1, claude_local: 1, kimi_local: 1 }],
    ]),
  });
  assert.deepEqual(atBaseline.violations, []);
  assert.deepEqual(atBaseline.legacyOverages, []);

  // One occurrence over an identity's baseline: fails with the exact line.
  const overBaseline = scanForAdapterTypeLiterals({
    root,
    legacyBaselines: new Map([
      ["ui/src/components/Legacy.tsx", { codex_local: 1, claude_local: 1 }],
    ]),
  });
  assert.deepEqual(overBaseline.legacyOverages, [
    { file: "ui/src/components/Legacy.tsx", literal: "kimi_local", line: 3, baseline: 0 },
  ]);

  // Below baseline: reported as an improvement, not a failure.
  const underBaseline = scanForAdapterTypeLiterals({
    root,
    legacyBaselines: new Map([
      ["ui/src/components/Legacy.tsx", { codex_local: 2, claude_local: 1, kimi_local: 1 }],
    ]),
  });
  assert.deepEqual(underBaseline.violations, []);
  assert.deepEqual(underBaseline.legacyOverages, []);
  assert.equal(underBaseline.legacyImprovements.length, 1);
});

test("an equal-count identity swap in a legacy file is a violation", (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Total count matches the baseline sum — but one "gemini_local" was
  // replaced with a second "codex_local", exceeding that identity's baseline.
  writeFileSync(
    join(root, "ui/src/components/Legacy.tsx"),
    ['const a = t === "codex_local";', 'const b = t === "codex_local";'].join("\n"),
  );

  const swapped = scanForAdapterTypeLiterals({
    root,
    legacyBaselines: new Map([
      ["ui/src/components/Legacy.tsx", { codex_local: 1, gemini_local: 1 }],
    ]),
  });
  assert.deepEqual(swapped.legacyOverages, [
    { file: "ui/src/components/Legacy.tsx", literal: "codex_local", line: 2, baseline: 1 },
  ]);

  // A brand-new identity at equal total count is likewise an overage.
  writeFileSync(
    join(root, "ui/src/components/Legacy.tsx"),
    ['const a = t === "codex_local";', 'const b = t === "kimi_local";'].join("\n"),
  );
  const newIdentity = scanForAdapterTypeLiterals({
    root,
    legacyBaselines: new Map([
      ["ui/src/components/Legacy.tsx", { codex_local: 1, gemini_local: 1 }],
    ]),
  });
  assert.deepEqual(newIdentity.legacyOverages, [
    { file: "ui/src/components/Legacy.tsx", literal: "kimi_local", line: 2, baseline: 0 },
  ]);
});

test("ignores test files, stories, and directories outside the scan scope", (t) => {
  const root = makeFixtureRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, "ui/src/adapters/kimi-local"), { recursive: true });
  writeFileSync(
    join(root, "ui/src/lib/example.test.ts"),
    'expect(adapterType).toBe("kimi_local");\n',
  );
  writeFileSync(
    join(root, "ui/src/components/Example.stories.tsx"),
    'const type = "gemini_local";\n',
  );
  writeFileSync(
    join(root, "ui/src/adapters/kimi-local/index.ts"),
    'export const type = "kimi_local"; // registration home: allowed\n',
  );

  const { violations, legacyOverages } = scanForAdapterTypeLiterals({ root, legacyBaselines: new Map() });
  assert.deepEqual(violations, []);
  assert.deepEqual(legacyOverages, []);
});

test("the real repository passes with the current legacy baselines", () => {
  const { violations, legacyOverages } = scanForAdapterTypeLiterals();
  assert.deepEqual(violations, []);
  assert.deepEqual(legacyOverages, []);
});
