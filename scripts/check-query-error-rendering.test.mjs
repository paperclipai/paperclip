import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanQueryErrorRendering, scanSource } from "./check-query-error-rendering.mjs";

const rulesFor = (source) => scanSource(source, "ui/src/x.tsx").map((finding) => finding.rule);

test("flags raw error renders", () => {
  assert.deepEqual(rulesFor("<p>{error.message}</p>"), ["raw-error-message"]);
  assert.deepEqual(rulesFor("<p>{query.error?.message}</p>"), ["raw-error-message"]);
  assert.deepEqual(rulesFor("<p>{saveError.message}</p>"), ["raw-error-message"]);
  assert.deepEqual(rulesFor("<p>{(error as Error).message}</p>"), ["cast-error-message"]);
});

test("flags isError render branches but not optional chaining or types", () => {
  assert.deepEqual(rulesFor("{isError ? <Error /> : <List />}"), ["is-error-render"]);
  assert.deepEqual(rulesFor("{query.isError && <Error />}"), ["is-error-render"]);
  assert.deepEqual(rulesFor("isError?: boolean;"), []);
  assert.deepEqual(rulesFor("const x = state.isError ?? false;"), []);
});

test("flags retry: false", () => {
  assert.deepEqual(rulesFor("useQuery({ queryKey, queryFn, retry: false })"), ["retry-false"]);
  assert.deepEqual(rulesFor("useQuery({ retry: shouldRetryRequest })"), []);
});

test("skips comments and explicitly accepted lines", () => {
  assert.deepEqual(rulesFor("// {error.message} is what we used to render"), []);
  assert.deepEqual(rulesFor("  retry: false, // query-error-ok: probe must fail fast"), []);
});

test("marks findings in migrated files as enforced", () => {
  const root = mkdtempSync(join(tmpdir(), "query-error-rendering-"));
  try {
    mkdirSync(join(root, "pages"));
    writeFileSync(join(root, "pages", "Migrated.tsx"), "export const A = () => <p>{error.message}</p>;\n");
    writeFileSync(join(root, "pages", "Legacy.tsx"), "export const B = () => <p>{error.message}</p>;\n");
    const findings = scanQueryErrorRendering({ root, allowlist: new Set(), enforcedFiles: new Set() });
    assert.equal(findings.length, 2);
    assert.ok(findings.every((finding) => finding.enforced === false));
    const migrated = findings.find((finding) => finding.path.endsWith("Migrated.tsx"));
    const enforced = scanQueryErrorRendering({ root, allowlist: new Set(), enforcedFiles: new Set([migrated.path]) });
    assert.deepEqual(
      enforced.map((finding) => [finding.path.endsWith("Migrated.tsx"), finding.enforced]).sort(),
      [[false, false], [true, true]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scans a tree, skips tests, and honors the allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "query-error-rendering-"));
  try {
    mkdirSync(join(root, "pages"));
    writeFileSync(join(root, "pages", "Page.tsx"), "export const A = () => <p>{error.message}</p>;\n");
    writeFileSync(join(root, "pages", "Page.test.tsx"), "expect(<p>{error.message}</p>);\n");
    const findings = scanQueryErrorRendering({ root, allowlist: new Set(), enforcedFiles: new Set() });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "raw-error-message");
    assert.equal(findings[0].line, 1);
    const allowed = scanQueryErrorRendering({
      root,
      allowlist: new Set([`${findings[0].path}:raw-error-message`]),
      enforcedFiles: new Set(),
    });
    assert.equal(allowed.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
