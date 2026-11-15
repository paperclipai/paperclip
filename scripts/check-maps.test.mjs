import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkMaps } from "./check-maps.mjs";

const record = `API: \`present\` — POST /api/example.
Agent access: \`partial\` — agent REST; native binding missing.
Policy: same company and calling owner.
Evidence: \`source-only\` — implementation inspected.
Verification: \`not-run\` — assert permitted owner and denied other company.
Gaps: native mutation path.
`;

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-map-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["maps/feature-map", "maps/agent-access-map"]) mkdirSync(path.join(root, dir), { recursive: true });
  const product = path.join(root, "maps/feature-map/example.md");
  const agent = path.join(root, "maps/agent-access-map/example.md");
  writeFileSync(path.join(root, "maps/README.md"), "# Contract\n");
  for (const dir of ["feature-map", "agent-access-map"]) writeFileSync(path.join(root, "maps", dir, "README.md"), "[Example](example.md)\n");
  writeFileSync(product, '---\nnavigation: {"section":"Work","sectionOrder":10,"order":10}\n---\n# Example\n\nExample workflows.\n\n[Agent access](../agent-access-map/example.md)\n\n## Sub-features\n\n- `create`: create a record.\n\n## How to get to it (user POV)\n');
  writeFileSync(agent, `# Agent access\n\nProduct map: [Example](../feature-map/example.md).\n\nReview date: 2026-10-12. Source commit: \`${"a".repeat(40)}\`.\n\n## \`create\`\n\nReview: \`baseline\`.\n\n${record}`);
  return { root, product, agent };
}

test("paired source-only records pass without being promoted to live proof", (t) => {
  const { root } = fixture(t);
  assert.deepEqual(checkMaps(root), { errors: [], areas: 1, capabilities: 1 });
});

test("a product area cannot lose its companion", (t) => {
  const { root, agent } = fixture(t);
  rmSync(agent);
  assert.ok(checkMaps(root).errors.some((error) => error.includes("missing file")));
});

test("renaming a capability on one side reports missing and orphan IDs", (t) => {
  const { root, agent } = fixture(t);
  writeFileSync(agent, readFileSync(agent, "utf8").replace("## `create`", "## `update`"));
  const result = checkMaps(root);
  assert.ok(result.errors.some((error) => error.includes("missing capability: create")));
  assert.ok(result.errors.some((error) => error.includes("orphan capability: update")));
});

test("duplicate IDs cannot disguise the missing capability", (t) => {
  const { root, agent } = fixture(t);
  writeFileSync(agent, readFileSync(agent, "utf8") + `\n## \`create\`\n\nReview: \`baseline\`.\n\n${record}`);
  assert.ok(checkMaps(root).errors.some((error) => error.includes("duplicate capability: create")));
});

test("a moved or deleted source reference is reported", (t) => {
  const { root, agent } = fixture(t);
  writeFileSync(agent, readFileSync(agent, "utf8") + "\n[Source](../../server/deleted.ts#L12)\n");
  assert.ok(checkMaps(root).errors.some((error) => error.includes("broken local reference")));
});

test("every reviewed operation needs its own access fields", (t) => {
  const { root, agent } = fixture(t);
  const text = readFileSync(agent, "utf8").replace("Review: `baseline`.", "Review: `operation-reviewed`.\n\n### `create`");
  writeFileSync(agent, text + `\n### \`update\`\n\n${record.replace(/^API:.*\n/m, "")}`);
  assert.ok(checkMaps(root).errors.some((error) => error.includes("missing API field")));
});

test("verified evidence cannot coexist with verification not run", (t) => {
  const { root, agent } = fixture(t);
  writeFileSync(agent, readFileSync(agent, "utf8").replace("Evidence: `source-only`", "Evidence: `verified`"));
  assert.ok(checkMaps(root).errors.some((error) => error.includes("verified evidence requires a passed verification record")));
});

test("an exception needs its reason rather than an empty exemption label", (t) => {
  const { root, agent } = fixture(t);
  writeFileSync(agent, readFileSync(agent, "utf8").replace(/^API:.*$/m, "API: `not-applicable`."));
  assert.ok(checkMaps(root).errors.some((error) => error.includes("not-applicable needs a reason")));
});

test("API presence needs a concrete method and path", (t) => {
  const { root, agent } = fixture(t);
  writeFileSync(agent, readFileSync(agent, "utf8").replace("POST /api/example", "see the backend"));
  assert.ok(checkMaps(root).errors.some((error) => error.includes("present API needs an exact method/path")));
});

test("an empty policy cannot borrow the next field's content", (t) => {
  const { root, agent } = fixture(t);
  writeFileSync(agent, readFileSync(agent, "utf8").replace(/^Policy:.*$/m, "Policy:\n"));
  assert.ok(checkMaps(root).errors.some((error) => error.includes("missing Policy field")));
});
