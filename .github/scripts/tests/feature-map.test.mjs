import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkFeatureMap } from "../../../scripts/check-feature-map.mjs";

const recipe = `# Example

A person can complete an example journey.

## Sub-features

- \`submit\`: saves the result and shows errors.

## How to get to it (user POV)

### \`task\`

Open the task.

## Driving it

Preconditions: an isolated instance.

### \`task\`

Automated: [component test](../ui/src/pages/Example.test.tsx).

Manual: submit, reload, and inspect the persisted result.

## Gotchas

- A component test does not prove live delivery.
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "feature-map-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const coverage = { version: 1, areas: [{
    id: "tasks", title: "Tasks", status: "partial", features: ["example.md"],
    gap: "Task creation has no recipe yet.", paths: ["ui/src/pages/Example.tsx"],
  }] };
  write("feature-map/README.md", "# Map\n\n## Features\n\n[Example](./example.md)\n");
  write("feature-map/example.md", recipe);
  write("feature-map/coverage.json", JSON.stringify(coverage));
  write("ui/src/pages/Example.tsx", "export const Example = () => null;\n");
  write("ui/src/pages/Example.test.tsx", "// referenced test fixture\n");
  return { root, write, coverage, check: () => checkFeatureMap(root).errors };
}

test("the checked-in feature map matches the current repository", () => {
  assert.deepEqual(checkFeatureMap().errors, []);
});

test("accepts a documented partial area and excludes tests and stories from page coverage", (t) => {
  const f = fixture(t);
  f.write("ui/src/pages/New.spec.tsx", "");
  f.write("ui/src/pages/New.stories.tsx", "");
  assert.deepEqual(f.check(), []);
});

test("accepts CRLF line endings in the index and recipes", (t) => {
  const f = fixture(t);
  for (const path of ["feature-map/README.md", "feature-map/example.md"]) {
    f.write(path, readFileSync(join(f.root, path), "utf8").replace(/\n/g, "\r\n"));
  }
  assert.deepEqual(f.check(), []);
});

test("new nested pages cannot hide under a previously covered directory", (t) => {
  const f = fixture(t);
  f.write("ui/src/pages/apps/new/NewPanel.tsx", "");
  assert.match(f.check().join("\n"), /unclassified page ui\/src\/pages\/apps\/new\/NewPanel.tsx/);
});

test("deleted or renamed test references fail even inside runnable commands", (t) => {
  const f = fixture(t);
  f.write("feature-map/example.md", recipe + "\n```sh\npnpm exec vitest run server/src/renamed.test.ts\n```\n");
  rmSync(join(f.root, "ui/src/pages/Example.test.tsx"));
  const errors = f.check().join("\n");
  assert.match(errors, /missing test ui\/src\/pages\/Example.test.tsx/);
  assert.match(errors, /missing test server\/src\/renamed.test.ts/);
});

test("broken documentation links fail, external URLs and local anchors are accepted", (t) => {
  const f = fixture(t);
  f.write("feature-map/example.md", recipe + "\n[External](https://example.com/tests/external.test.ts) [Here](#gotchas) [Missing](../doc/missing.md#section)\n");
  assert.deepEqual(f.check(), ["example.md: broken local link ../doc/missing.md#section"]);
});

test("references under .github are checked as full paths rather than scripts fragments", (t) => {
  const f = fixture(t);
  f.write(".github/scripts/tests/example.test.mjs", "// fixture\n");
  f.write("feature-map/example.md", recipe + "\n```sh\nnode --test .github/scripts/tests/example.test.mjs\n```\n");
  assert.deepEqual(f.check(), []);
});

test("new recipes must be indexed and missing recipes must be removed from the index", (t) => {
  const f = fixture(t);
  f.write("feature-map/unlisted.md", recipe);
  f.write("feature-map/README.md", "# Map\n\n## Features\n\n[Missing](./missing.md)\n");
  const errors = f.check().join("\n");
  assert.match(errors, /Features must link example.md exactly once/);
  assert.match(errors, /Features must link unlisted.md exactly once/);
  assert.match(errors, /unknown recipe missing.md/);
});

test("missing sections and missing preconditions fail", (t) => {
  const f = fixture(t);
  f.write("feature-map/example.md", recipe.replace("## Gotchas", "## Notes"));
  assert.match(f.check().join("\n"), /expected sections in order/);
  f.write("feature-map/example.md", recipe.replace("Preconditions:", "Setup:"));
  assert.match(f.check().join("\n"), /must start with Preconditions:/);
});

test("entry points cannot silently lack a driving recipe or a manual coverage statement", (t) => {
  const f = fixture(t);
  f.write("feature-map/example.md", recipe.replace("Open the task.", "Open the task.\n\n### `chat`\n\nOpen Chat."));
  assert.match(f.check().join("\n"), /entry points and driving recipe IDs must match/);
  f.write("feature-map/example.md", recipe.replace("Manual:", "Notes:"));
  assert.match(f.check().join("\n"), /describe Automated: evidence\/gaps and Manual: steps/);
});

test("duplicate entry-point and sub-feature IDs fail", (t) => {
  const f = fixture(t);
  f.write("feature-map/example.md", recipe.replace("Open the task.", "Open the task.\n\n### `task`\n\nAgain.")
    .replace("## How to get", "- `submit`: another result.\n\n## How to get"));
  const errors = f.check().join("\n");
  assert.match(errors, /unique H3 entry-point IDs/);
  assert.match(errors, /unique backticked IDs/);
});

test("the inventory rejects stale paths, duplicate classification, and nonexistent recipes", (t) => {
  const f = fixture(t);
  f.coverage.areas.push({ ...f.coverage.areas[0], id: "other", features: ["missing.md"],
    paths: ["ui/src/pages/Example.tsx", "ui/src/pages/Gone.tsx"] });
  f.write("feature-map/coverage.json", JSON.stringify(f.coverage));
  const errors = f.check().join("\n");
  assert.match(errors, /unknown recipe missing.md/);
  assert.match(errors, /duplicate page ui\/src\/pages\/Example.tsx/);
  assert.match(errors, /stale or non-page path ui\/src\/pages\/Gone.tsx/);
});

test("unmapped areas need an explanation and cannot claim recipe coverage", (t) => {
  const f = fixture(t);
  Object.assign(f.coverage.areas[0], { status: "unmapped", gap: " " });
  f.write("feature-map/coverage.json", JSON.stringify(f.coverage));
  const errors = f.check().join("\n");
  assert.match(errors, /explain the remaining gap/);
  assert.match(errors, /unmapped areas must have none/);
});

test("CI continues to run the test glob that includes this gate", () => {
  const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  assert.match(workflow, /node --test ['"]?\.github\/scripts\/tests\/\*\.test\.mjs/);
});
