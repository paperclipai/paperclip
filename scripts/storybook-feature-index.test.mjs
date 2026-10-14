import assert from "node:assert/strict";
import fs, { existsSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { featureArtifacts, featureIndex, featureOrder, generateFeatureArtifacts } from "./storybook-feature-index.mjs";
import { mapFixture } from "./map-test-fixture.mjs";

test("recipes own discovery, names, section order and multiline capability descriptions", t => {
  const f = mapFixture(t);
  f.feature("goals", "Goals", ["hierarchy"], { order: 20 });
  f.feature("apps", "Apps", ["connect"], { section: "Connections", sectionOrder: 20 });
  const recipe = path.join(f.root, "maps/feature-map/tasks.md");
  f.write("maps/feature-map/tasks.md", readFileSync(recipe, "utf8").replace("create work.", "Create work;\n  retain its description."));
  const index = featureIndex(f.root);
  assert.deepEqual(index.sections.map(section => section.title), ["Work", "Connections"]);
  assert.deepEqual(index.sections.flatMap(section => section.features.map(feature => feature.id)), ["tasks", "goals", "apps"]);
  assert.equal(index.sections[0].features[0].capabilities[0].description, "Create work; retain its description.");
  assert.deepEqual(featureOrder(index), ["Overview", "Work", ["Tasks", ["Overview", "*"], "Goals", ["Overview", "*"]], "Connections", ["Apps", ["Overview", "*"]], "Foundations"]);
});

test("equal local orders preserve independently added features using their stable filename", t => {
  const f = mapFixture(t);
  f.feature("goals", "Goals");
  f.feature("apps", "Apps");
  assert.deepEqual(featureIndex(f.root).sections[0].features.map(feature => feature.id), ["apps", "goals", "tasks"]);
});

test("every discovered feature gets a stable overview, including areas without stories", t => {
  const f = mapFixture(t);
  f.feature("goals", "CLI/API and goals", ["hierarchy"]);
  const index = featureIndex(f.root);
  const output = featureArtifacts(index).get("ui/storybook/generated/features/goals.stories.tsx");
  assert.match(output, /id: "feature-map-goals"/);
  assert.match(output, /title: "Work\/CLI, API and goals\/Overview"/);
});

test("fresh generation rebuilds missing outputs, removes retired overviews and never edits authored preview", t => {
  const f = mapFixture(t);
  const authored = readFileSync(path.join(f.root, "ui/storybook/.storybook/preview-base.tsx"), "utf8");
  f.feature("goals", "Goals", ["hierarchy"]);
  generateFeatureArtifacts(f.root);
  const overview = path.join(f.root, "ui/storybook/generated/features/goals.stories.tsx");
  assert.ok(existsSync(overview));
  assert.match(readFileSync(path.join(f.root, "ui/storybook/.storybook/preview.tsx"), "utf8"), /storySort: \{ order: \[/);
  rmSync(path.join(f.root, "maps/feature-map/goals.md"));
  rmSync(path.join(f.root, "maps/agent-access-map/goals.md"));
  generateFeatureArtifacts(f.root);
  assert.equal(existsSync(overview), false);
  assert.equal(readFileSync(path.join(f.root, "ui/storybook/.storybook/preview-base.tsx"), "utf8"), authored);
  assert.match(readFileSync(path.join(f.root, "maps/generated/feature-map.md"), "utf8"), /Tasks/);
});

test("missing metadata, duplicate capabilities and inconsistent group order fail visibly", t => {
  const f = mapFixture(t);
  f.write("maps/feature-map/new.md", "# New\n");
  assert.throws(() => featureIndex(f.root), /missing navigation/);
  f.feature("new", "New", ["create", "create"]);
  assert.throws(() => featureIndex(f.root), /duplicate capability/);
  f.feature("new", "New", ["create"], { sectionOrder: 99 });
  assert.throws(() => featureIndex(f.root), /inconsistent section order/);
});

test("overlapping generators can both retire the same overview", t => {
  const f = mapFixture(t);
  const retired = "ui/storybook/generated/features/retired.stories.tsx";
  f.write(retired, "export const Overview = {};\n");
  const directory = path.join(f.root, "ui/storybook/generated/features");
  const readDirectory = fs.readdirSync;
  let competed = false;
  // Reproduce the interleaving deterministically: the other generator removes
  // the file after this generator lists it, before this generator removes it.
  const mock = t.mock.method(fs, "readdirSync", (...args) => {
    const listing = readDirectory(...args);
    if (args[0] === directory && !competed) {
      competed = true;
      rmSync(path.join(f.root, retired));
    }
    return listing;
  });
  syncBuiltinESMExports();
  try {
    generateFeatureArtifacts(f.root);
    assert.equal(competed, true);
    assert.equal(existsSync(path.join(f.root, retired)), false);
    assert.ok(existsSync(path.join(directory, "tasks.stories.tsx")));
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("verification guidance rejects orphan capability references", t => {
  const f = mapFixture(t);
  const file = "maps/feature-map/tasks.md";
  f.write(file, readFileSync(path.join(f.root, file), "utf8") + "\n### Storybook verification\n\n#### `missing`\n\nScope: cli\nStorybook: Use CLI.\nProduction: Execute.\nSources: Inspect.\n");
  assert.throws(() => featureIndex(f.root), /unknown or duplicate verification capability/);
});
