import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { catalogFromStories, generateStorybook, renderIndex, renderVerification, scanStories, validateCatalog } from "./storybook-catalog.mjs";
import { featureIndex } from "./feature-map.mjs";
import { mapFixture } from "./map-test-fixture.mjs";

function inspect(f) {
  const index = featureIndex(f.root);
  const stories = scanStories(f.root);
  const catalog = catalogFromStories(stories, index);
  return { catalog, stories, index, errors: validateCatalog(catalog, stories, index) };
}

test("source annotations assemble an inventory without a registry or review stamps", t => {
  const f = mapFixture(t);
  const result = inspect(f);
  assert.deepEqual(result.errors, []);
  assert.equal(result.catalog.entries[0].purpose, "task");
  assert.equal(result.catalog.entries[0].status, "unreviewed");
  assert.equal(result.catalog.entries[0].stableId, "stable-task");
  assert.equal(Object.hasOwn(result.catalog.entries[0], "fingerprint"), false);
  assert.equal(Object.hasOwn(result.catalog.entries[0], "reviewedAt"), false);
  f.story("new");
  assert.equal(inspect(f).catalog.entries.length, 2);
  rmSync(path.join(f.root, f.file));
  assert.equal(inspect(f).catalog.entries.length, 1);
});

test("unknown capabilities, invalid annotations and inappropriate homes fail", t => {
  const f = mapFixture(t);
  f.story("task", { capabilities: ["tasks/missing"] });
  assert.match(inspect(f).errors.join("\n"), /unknown feature capability/);
  f.story("task", { capabilities: [], status: "passed" });
  assert.match(inspect(f).errors.join("\n"), /invalid product status/);
  assert.match(inspect(f).errors.join("\n"), /explicit reason/);
  f.story("task", { capabilities: "tasks/create" });
  assert.match(inspect(f).errors.join("\n"), /array of IDs/);
  f.story("task", { capabilities: ["tasks/create"] }, { title: "Other/Task" });
  assert.match(inspect(f).errors.join("\n"), /sidebar title/);
});

test("metadata is parsed without executing code or accepting obsolete bookkeeping fields", t => {
  const f = mapFixture(t);
  f.write(f.file, `export default { id: 'task', title: 'Work/Tasks/Test', parameters: { paperclip: (() => { throw new Error('executed'); })() } }; export const Empty = {};`);
  assert.throws(() => scanStories(f.root), /expressions are not executed/);
  f.story("task", { capabilities: ["tasks/create"], fingerprint: "old" });
  assert.throws(() => scanStories(f.root), /unknown paperclip field fingerprint/);
  f.write(f.file, "export default { id: 'task', title: 'Work/Tasks/Test', parameters: { paperclip: { capabilities: [], capabilities: [] } } }; export const Empty = {};");
  assert.throws(() => scanStories(f.root), /unique literal properties/);
});

test("parameter spreads cannot silently overwrite a source annotation", t => {
  const f = mapFixture(t);
  f.write(f.file, "export default { id: 'task', title: 'Work/Tasks/Test', parameters: { paperclip: { capabilities: [] }, ...other } }; export const Empty = {};");
  assert.throws(() => scanStories(f.root), /must follow parameter spreads/);
  f.write(f.file, "export default { id: 'task', title: 'Work/Tasks/Test', parameters: { paperclip: { capabilities: [] }, [key]: other } }; export const Empty = {};");
  assert.throws(() => scanStories(f.root), /must follow parameter spreads/);
  f.write(f.file, "export default { id: 'task', title: 'Work/Tasks/Test', parameters: { ['paperclip']: { capabilities: [] } } }; export const Empty = {};");
  assert.throws(() => scanStories(f.root), /must be a literal property/);
});

test("foundations preserve home and cross-capability references", t => {
  const f = mapFixture(t);
  f.story("control", { capabilities: ["tasks/create"], home: "foundations", exception: "Shared control", implementation: "production" }, { area: "foundations", title: "Foundations/Control" });
  const { catalog, errors } = inspect(f);
  assert.deepEqual(errors, []);
  assert.equal(catalog.entries.find(entry => entry.stableId === "stable-control").home, "foundations");
  f.story("control", { capabilities: ["tasks/create"], home: "foundations" }, { area: "foundations", title: "Foundations/Control" });
  assert.match(inspect(f).errors.join("\n"), /foundation home needs an explicit reason/);
});

test("design proposals keep stable IDs and capability links in a separate catalog section without filling coverage gaps", t => {
  const f = mapFixture(t);
  const originalIds = scanStories(f.root)[0].ids;
  rmSync(path.join(f.root, f.file));
  f.story("task", {
    home: "design-proposals",
    status: "proposed",
    capabilities: ["tasks/create", "tasks/discussion"],
    implementation: "production",
    boundary: "fixtures",
    exception: "Opt-in task row refresh awaiting design review and application rollout.",
  }, { area: "design-proposals", title: "Design proposals/Tasks/Task row" });
  const { catalog, stories, index, errors } = inspect(f);
  assert.deepEqual(errors, []);
  assert.deepEqual(stories[0].ids, originalIds);
  assert.equal(catalog.entries[0].home, "design-proposals");
  assert.equal(catalog.entries[0].purpose, "Tasks/Task row");
  const report = renderIndex(catalog, stories, index);
  const proposalSection = report.split("## Design proposals\n")[1].split("## Work\n")[0];
  assert.match(proposalSection, /Design proposals\/Tasks\/Task row/);
  assert.doesNotMatch(report, /feature-map\/design-proposals\.md/);
  assert.match(report, /- `tasks\/create`: .*\(proposed\)/);
  assert.match(report, /- `tasks\/discussion`: .*\(proposed\)/);
  assert.match(renderVerification(catalog, index), /2 without a current, mixed or unreviewed example/);
});

test("design proposal homes require proposed status, a staging reason and their own navigation", t => {
  const f = mapFixture(t);
  const metadata = { home: "design-proposals", status: "proposed", capabilities: ["tasks/create"], exception: "Staged refresh for review." };
  const options = { area: "design-proposals", title: "Design proposals/Tasks/Task row" };
  for (const status of ["current", "mixed", "unreviewed", "historical"]) {
    f.story("proposal", { ...metadata, status }, options);
    assert.match(inspect(f).errors.join("\n"), /design proposal home requires proposed status/);
  }
  f.story("proposal", { ...metadata, exception: undefined }, options);
  assert.match(inspect(f).errors.join("\n"), /design proposal home needs an explicit staging reason/);
  f.story("proposal", metadata, { ...options, title: "Work/Tasks/Task row" });
  assert.match(inspect(f).errors.join("\n"), /sidebar title/);
  f.story("misplaced", metadata, { title: options.title });
  assert.match(inspect(f).errors.join("\n"), /primary feature folder design-proposals/);
});

test("duplicate IDs, missing replacement references and collisions with generated guides fail", t => {
  const f = mapFixture(t);
  f.story("other", { capabilities: ["tasks/create"] }, { id: "stable-task" });
  assert.match(inspect(f).errors.join("\n"), /Duplicate story IDs/);
  f.story("other", { capabilities: ["tasks/create"] }, { id: "feature-map-tasks", exports: "export const Overview = {};" });
  assert.match(inspect(f).errors.join("\n"), /Duplicate story IDs/);
  f.story("other", { capabilities: ["tasks/create"], replacement: "missing.stories.tsx" });
  assert.match(inspect(f).errors.join("\n"), /replacement story is missing/);
});

test("recipe, component and shared fixture edits need no fingerprint acknowledgements", t => {
  const f = mapFixture(t);
  const before = inspect(f).catalog;
  f.write("ui/src/Task.tsx", "export const Task = () => null;");
  f.write("ui/storybook/.storybook/preview-base.tsx", "export default { parameters: { changed: true } };");
  const file = "maps/feature-map/tasks.md";
  f.write(file, readFileSync(path.join(f.root, file), "utf8").replace("discussion work.", "Discuss revised behavior."));
  assert.deepEqual(inspect(f).catalog, before);
  assert.deepEqual(inspect(f).errors, []);
});

test("check mode needs no generated outputs and generation leaves authored files intact", t => {
  const f = mapFixture(t);
  const before = readFileSync(path.join(f.root, f.file), "utf8");
  generateStorybook(f.root, { write: false });
  assert.equal(existsSync(path.join(f.root, "ui/storybook/generated")), false);
  generateStorybook(f.root);
  assert.ok(existsSync(path.join(f.root, "ui/storybook/generated/catalog.json")));
  assert.ok(existsSync(path.join(f.root, "maps/generated/verification.md")));
  assert.equal(readFileSync(path.join(f.root, f.file), "utf8"), before);
  const first = readFileSync(path.join(f.root, "maps/generated/storybook.md"), "utf8");
  generateStorybook(f.root);
  assert.equal(readFileSync(path.join(f.root, "maps/generated/storybook.md"), "utf8"), first);
});

test("gap reports combine associations with local verification scope and retain historical gaps", t => {
  const f = mapFixture(t);
  f.story("task", { capabilities: ["tasks/create"], status: "historical" });
  const file = "maps/feature-map/tasks.md";
  f.write(file, readFileSync(path.join(f.root, file), "utf8") + "\n### Storybook verification\n\n#### `create`\n\nScope: cli\nStorybook: No story required for the command.\nProduction: Run the command.\nSources: Inspect the CLI.\n");
  const { catalog, index } = inspect(f);
  const report = renderVerification(catalog, index);
  assert.match(report, /2 without a current, mixed or unreviewed example/);
  assert.match(report, /No story required for the command/);
  assert.match(report, /Production: Run the command/);
});

test("the CSF parser preserves explicit IDs, export filtering and play counts", t => {
  const f = mapFixture(t);
  f.write(f.file, `import type { Meta } from '@storybook/react-vite';
    const meta = { id: 'stable-task', title: 'Work/Tasks/Create', excludeStories: ['helper'], parameters: { paperclip: { capabilities: ['tasks/create'] } } } satisfies Meta;
    export default meta;
    export const helper = {};
    export const Empty = {};
    export const Filled = { play: async () => {} };
  `);
  const [story] = scanStories(f.root);
  assert.deepEqual(story.ids, ["stable-task--empty", "stable-task--filled"]);
  assert.equal(story.plays, 1);
});

test("independent story and feature branches merge in either order with identical clean generated maps", t => {
  const f = mapFixture(t);
  f.write(".gitignore", readFileSync(path.join(f.root, ".gitignore"), "utf8") + "node_modules\n");
  const git = (...args) => execFileSync("git", ["-c", "user.name=Map test", "-c", "user.email=map@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd: f.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  git("init", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "Initial recipes and story");
  git("checkout", "-b", "story-change");
  f.story("task", { capabilities: ["tasks/create"], notes: "Retain creation draft." }, { exports: "export const Empty = {}; export const Draft = {};" });
  git("add", "."); git("commit", "-qm", "Add task draft example");
  git("checkout", "-b", "feature-addition", "main");
  f.feature("goals", "Goals", ["hierarchy"], { order: 20 });
  f.story("goal", { capabilities: ["goals/hierarchy"] }, { area: "goals", title: "Work/Goals/Goal" });
  git("add", "."); git("commit", "-qm", "Add goal capability and example");
  const results = [];
  for (const [first, second] of [["story-change", "feature-addition"], ["feature-addition", "story-change"]]) {
    git("checkout", "-b", `merged-${first}`, "main");
    git("merge", "--no-edit", first);
    git("merge", "--no-edit", second);
    const result = generateStorybook(f.root);
    assert.equal(git("status", "--porcelain"), "");
    assert.deepEqual(result.stories.flatMap(story => story.ids).sort(), ["stable-goal--empty", "stable-task--draft", "stable-task--empty"]);
    results.push(["ui/storybook/generated/catalog.json", "ui/storybook/generated/feature-index.json", "maps/generated/storybook.md", "maps/generated/verification.md", "ui/storybook/.storybook/preview.tsx"].map(file => readFileSync(path.join(f.root, file), "utf8")));
  }
  assert.deepEqual(results[0], results[1]);
});
