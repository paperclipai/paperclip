import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { parseArgs, UsageError } from "./lib/args.mjs";
import { NOT_RUN } from "./lib/check.mjs";
import { buildContext, deriveDirection, parseSurfaces, sentenceCase } from "./lib/context.mjs";
import { detectMode, expectedStoryStatus, labStage, MODE_A_SENTENCE } from "./lib/modes.mjs";
import { pickPorts } from "./lib/ports.mjs";
import { directionLine, insertDirection, readRegistry } from "./lib/registry-edit.mjs";
import { motionBlockFor, renderLab } from "./lib/render.mjs";
import { gitignoreWithLine, launchJsonWithEntries } from "./lib/shared-files.mjs";
import { checkRendered, commentLines, lineCount, MAX_LINES } from "./lib/write.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLD = path.join(SCRIPT_DIR, "scaffold.mjs");
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../../..");
const MOTION_ASSET = path.join(SCRIPT_DIR, "../assets/motion/v1-mvp-motion.css");
const D5_TOKENS = path.join(REPO_ROOT, "ui/src/artifact-directions/directions/d5-v1-mvp/tokens.css");

const SHAPES = {
  composer: ["--slug", "composer", "--title", "Composer", "--surfaces", "thread:Task-thread:960@tasks,panel:Right-panel:434@tasks", "--directions", "3"],
  "inbox-row": ["--slug", "inbox-row", "--title", "Inbox row", "--surfaces", "inbox:Inbox:960@other", "--directions", "2"],
  "agent-profile-card": ["--slug", "agent-profile-card", "--title", "Agent profile card", "--surfaces", "card:Agents-page:1152@other", "--directions", "3"],
};

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "directions-lab-"));
  mkdirSync(path.join(root, ".claude"), { recursive: true });
  mkdirSync(path.join(root, "ui/src"), { recursive: true });
  mkdirSync(path.join(root, "ui/storybook/stories/design-proposals"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, ".claude/launch.json"), `${JSON.stringify({ version: "0.0.1", configurations: [{ name: "paperclip", port: 3121 }] }, null, 2)}\n`);
  writeFileSync(path.join(root, ".gitignore"), "node_modules\ndist/\ndist-flow-preview/\nserver/ui-dist/\n");
  writeFileSync(path.join(root, "scripts/storybook-catalog.mjs"), `const sentence = "${MODE_A_SENTENCE}";\n`);
  return root;
}

function run(args, { root }) {
  const result = spawnSync(process.execPath, [SCAFFOLD, ...args, ...(root ? ["--root", root] : [])], { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, json: () => JSON.parse(result.stdout) };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

const normalise = (css) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();

function d5MotionBlock() {
  const css = readFileSync(D5_TOKENS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf('[data-direction="d5-v1-mvp"] [data-rotate]');
  assert.ok(start > -1, "d5 tokens.css has the [data-rotate] rest rule");
  const media = css.indexOf("@media (prefers-reduced-motion: no-preference)", start);
  let depth = 0;
  let end = -1;
  for (let i = css.indexOf("{", media); i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return css.slice(start, end);
}

describe("flag parsing", () => {
  it("reads --k v and --k=v and boolean flags", () => {
    const { command, flags } = parseArgs(["new", "--slug", "x", "--directions=3", "--dry-run", "--json"]);
    assert.equal(command, "new");
    assert.deepEqual(flags, { slug: "x", directions: "3", "dry-run": true, json: true });
  });

  it("refuses unknown subcommands and flags", () => {
    assert.throws(() => parseArgs(["frobnicate"]), UsageError);
    assert.throws(() => parseArgs(["new", "--nope", "1"]), UsageError);
    assert.throws(() => parseArgs(["check", "--slug"]), UsageError);
  });
});

describe("context derivation", () => {
  const ports = { dev: 5200, preview: 5210 };

  it("derives casings, ids, cells and the landing rule", () => {
    const ctx = buildContext({ slug: "inbox-row", surfaces: "inbox:Inbox:960@other", directions: "2" }, { root: REPO_ROOT, ports });
    assert.equal(ctx.title, "Inbox row");
    assert.equal(sentenceCase("agent-profile-card"), "Agent profile card");
    assert.equal(buildContext({ slug: "inbox-row", title: "Inbox Row", surfaces: "inbox:Inbox:960@other", directions: "2" }, { root: REPO_ROOT, ports }).title, "Inbox Row");
    assert.equal(ctx.SLUG, "INBOX_ROW");
    assert.ok(!("Slug" in ctx));
    assert.equal(ctx.envOutDir, "INBOX_ROW_DIRECTIONS_OUT_DIR");
    assert.equal(ctx.storyId, "design-inbox-row-directions");
    assert.deepEqual(ctx.directions.map((d) => d.id), ["d1-refine", "d2-rethink"]);
    assert.deepEqual(ctx.kits.map((d) => d.key), ["1", "2", "0"]);
    assert.equal(ctx.cells, 3);
    assert.equal(ctx.multiSurface, false);
    assert.deepEqual(ctx.landing, { direction: "all", view: "board" });
    assert.equal(ctx.surfaces[0].body, "InboxBody");
    assert.equal(ctx.surfaces[0].fixture, "INBOX_ITEMS");
  });

  it("lands on the first surface when the board would exceed eight cells", () => {
    const ctx = buildContext({ slug: "wide", surfaces: "a:A:960@tasks,b:B:960@tasks,c:C:960@tasks", directions: "3" }, { root: REPO_ROOT, ports });
    assert.equal(ctx.cells, 12);
    assert.deepEqual(ctx.landing, { direction: "all", view: "a" });
  });

  it("refuses invalid inputs", () => {
    const base = { surfaces: "thread:Task-thread:960@tasks", directions: "3" };
    assert.throws(() => buildContext({ ...base, slug: "Bad Slug" }, { root: REPO_ROOT, ports }), /kebab-case/);
    assert.throws(() => buildContext({ ...base, slug: "x-directions" }, { root: REPO_ROOT, ports }), /-directions/);
    assert.throws(() => buildContext({ ...base, slug: "x", directions: "4" }, { root: REPO_ROOT, ports }), /--force-count/);
    assert.throws(() => buildContext({ ...base, slug: "x", directions: "1" }, { root: REPO_ROOT, ports }), /2 or 3/);
    assert.throws(() => buildContext({ ...base, slug: "x", surfaces: "thread:Task-thread:960@nowhere" }, { root: REPO_ROOT, ports }), /nav/);
    assert.throws(() => buildContext({ ...base, slug: "x", surfaces: "thread" }, { root: REPO_ROOT, ports }), /id:Label:width@nav/);
    assert.throws(() => buildContext({ ...base, slug: "x", group: "Widgets" }, { root: REPO_ROOT, ports }), /--group/);
    assert.throws(() => buildContext({ ...base, slug: "x", company: "ACME" }, { root: REPO_ROOT, ports }), /--company/);
    assert.throws(() => buildContext({ ...base, slug: "x", names: "A,B" }, { root: REPO_ROOT, ports }), /names/);
    assert.throws(() => buildContext({ ...base, slug: "x", landing: "d9-nope" }, { root: REPO_ROOT, ports }), /--landing/);
    assert.throws(() => parseSurfaces("board:Board:960@tasks"), /board/);
  });

  it("allows four to nine directions only with --force-count and explicit names", () => {
    const ctx = buildContext({ slug: "x", surfaces: "a:A:960@tasks", directions: "4", names: "One,Two,Three,Four", "force-count": true }, { root: REPO_ROOT, ports });
    assert.equal(ctx.directions.length, 4);
    assert.equal(ctx.forceCount, true);
    assert.equal(ctx.directions[3].id, "d4-four");
    assert.equal(deriveDirection(2, "Bold Paper").id, "d2-bold-paper");
    assert.equal(deriveDirection(2, "Bold Paper").prefix, "bold-paper");
  });
});

describe("ports", () => {
  it("skips launch.json, reserved and cache-dir ports and steps by 20", () => {
    const root = makeRoot();
    try {
      mkdirSync(path.join(root, "ui/node_modules/.vite-foo-directions-5200"), { recursive: true });
      assert.deepEqual(pickPorts(root), { dev: 5220, preview: 5230 });
      assert.throws(() => pickPorts(root, "3121,9000"), /already taken/);
      assert.throws(() => pickPorts(root, "9000"), /dev,preview/);
      assert.deepEqual(pickPorts(root, "9000,9001"), { dev: 9000, preview: 9001 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("write guards", () => {
  it("flags comment lines except the vitest environment pragma on line one", () => {
    assert.deepEqual(commentLines("a\n// b\n  /* c */\n  {/* d */}\n<!-- e -->\n"), [2, 3, 4, 5]);
    assert.deepEqual(commentLines("// @vitest-environment jsdom\n\nimport x from 'y';\n"), []);
    assert.deepEqual(commentLines("import x from 'y';\n// @vitest-environment jsdom\n"), [2]);
  });

  it("counts lines and refuses the limit and existing paths", () => {
    assert.equal(lineCount("a\nb\n"), 2);
    const root = makeRoot();
    try {
      const long = `${"x\n".repeat(MAX_LINES)}`;
      const errors = checkRendered(new Map([["ui/long.ts", long], [".gitignore", "ok\n"], ["ui/c.ts", "// nope\n"]]), { root });
      assert.ok(errors.some((error) => error.includes("600-line limit")));
      assert.ok(errors.some((error) => error.includes("already exists")));
      assert.ok(errors.some((error) => error.includes("comment line")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("shared files", () => {
  it("appends launch entries by name, idempotently, with two-space JSON", () => {
    const original = `${JSON.stringify({ version: "0.0.1", configurations: [{ name: "a", port: 1 }] }, null, 2)}\n`;
    const once = launchJsonWithEntries(original, [{ name: "b", port: 2 }]);
    const twice = launchJsonWithEntries(once, [{ name: "b", port: 2 }]);
    assert.equal(once, twice);
    assert.deepEqual(JSON.parse(twice).configurations.map((entry) => entry.name), ["a", "b"]);
  });

  it("inserts the gitignore line after the dist-flow-preview anchor, else at the end, once", () => {
    assert.equal(gitignoreWithLine("dist/\ndist-flow-preview/\nx/\n", "ui/dist-a-directions/"), "dist/\ndist-flow-preview/\nui/dist-a-directions/\nx/\n");
    assert.equal(gitignoreWithLine("dist/\n", "ui/dist-a-directions/"), "dist/\nui/dist-a-directions/\n");
    assert.equal(gitignoreWithLine("dist/", "ui/dist-a-directions/"), "dist/\nui/dist-a-directions/\n");
    const withLine = gitignoreWithLine("dist/\n", "ui/dist-a-directions/");
    assert.equal(gitignoreWithLine(withLine, "ui/dist-a-directions/"), withLine);
  });
});

describe("modes", () => {
  it("detects mode A from the catalog sentence and B otherwise", () => {
    const root = makeRoot();
    try {
      assert.equal(detectMode(root), "A");
      writeFileSync(path.join(root, "scripts/storybook-catalog.mjs"), "nothing here\n");
      assert.equal(detectMode(root), "B");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the lab stage from the explorations and maps it to the Compare status per mode", () => {
    const today = { id: "today", baseline: true, stage: "shipped" };
    const lab = (...stages) => [...stages.map((stage, index) => ({ id: `d${index + 1}-x`, stage })), today];
    assert.equal(labStage(lab("proposed", "proposed")), "proposed");
    assert.equal(labStage(lab("current", "proposed", "proposed")), "proposed");
    assert.equal(labStage(lab("current", "adopted")), "proposed");
    assert.equal(labStage(lab("historical", "proposed")), "proposed");
    assert.equal(labStage(lab("current", "current", "current")), "current");
    assert.equal(labStage(lab("current", "historical", "historical")), "current");
    assert.equal(labStage(lab("historical", "historical")), "historical");
    assert.equal(labStage([today]), "proposed");
    for (const stage of ["proposed", "current", "historical"]) assert.equal(expectedStoryStatus("A", stage), "proposed");
    assert.equal(expectedStoryStatus("B", "proposed"), "proposed");
    assert.equal(expectedStoryStatus("B", "current"), "current");
    assert.equal(expectedStoryStatus("B", "historical"), "historical");
  });
});

describe("motion asset", () => {
  it("equals the d5 block after comment stripping, whitespace normalisation and substitution", () => {
    const expected = normalise(d5MotionBlock()).replaceAll("d5-v1-mvp", "<id>").replaceAll("--v1-", "--<p>-");
    assert.equal(normalise(readFileSync(MOTION_ASSET, "utf8")), expected);
  });

  it("renders with the direction's id and prefix substituted", async () => {
    const block = await motionBlockFor({ id: "d2-bold", prefix: "bold" });
    assert.ok(block.includes('[data-direction="d2-bold"] [data-rotate]'));
    assert.ok(block.includes("--bold-hover-ease: 300ms cubic-bezier(0.3, 0, 0.1, 1)"));
    assert.ok(!block.includes("<id>") && !block.includes("<p>"));
  });
});

describe("rendering the three eval shapes", () => {
  const root = makeRoot();
  const results = {};

  before(() => {
    for (const [slug, args] of Object.entries(SHAPES)) {
      results[slug] = run(["new", ...args, "--skip-verify", "--json"], { root });
      assert.equal(results[slug].code, 0, results[slug].out);
    }
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("writes the lab, entry, config and story and reports the plan as JSON", () => {
    const plan = results.composer.json();
    assert.equal(plan.lab.storyId, "design-composer-directions");
    assert.equal(plan.cells, 8);
    assert.equal(plan.landing, "?d=all&s=board");
    assert.deepEqual(plan.ports, { dev: 5200, preview: 5210 });
    for (const file of ["ui/composer-directions.html", "ui/vite.composer-directions.config.mjs", "ui/storybook/stories/design-proposals/composer-directions.stories.tsx", "ui/src/composer-directions/registry.ts", "ui/src/composer-directions/kit.ts", "ui/src/composer-directions/lab-state.ts", "ui/src/composer-directions/main.tsx", "ui/src/composer-directions/shot.cjs", "ui/src/composer-directions/motion-contract.test.ts", "ui/src/composer-directions/today.test.tsx", "ui/src/composer-directions/frames/ThreadFrame.tsx", "ui/src/composer-directions/frames/PanelFrame.tsx", "ui/src/composer-directions/directions/today/ThreadBody.tsx", "ui/src/composer-directions/directions/d3-rethink/MotionSpecimen.tsx", "ui/src/composer-directions/directions/d3-rethink/PanelBody.tsx", "ui/src/composer-directions/directions/d3-rethink/tokens.css"]) {
      assert.ok(plan.paths.includes(file), `plan lists ${file}`);
      assert.ok(existsSync(path.join(root, file)), `${file} exists`);
    }
    assert.ok(!existsSync(path.join(root, "ui/src/composer-directions/directions/today/tokens.css")), "Today has no tokens.css");
  });

  it("renders the surfaces row only for more than one surface, with the legend moving into row 1 otherwise", () => {
    const multi = readFileSync(path.join(root, "ui/src/composer-directions/frames/LabToolbar.tsx"), "utf8");
    assert.ok(multi.includes("Composer surfaces"));
    assert.ok(multi.includes('label="Surface"'));
    assert.ok(multi.includes('<span className="ml-auto hidden lg:inline">{LEGEND}</span>'));
    assert.ok(multi.includes("hint: `The kit's ${registry.surfaces.length} surfaces on one sheet`"));
    assert.ok(multi.includes("...registry.surfaces.map((surface) => ({ value: surface.id, label: surface.label }))"));
    for (const slug of ["inbox-row", "agent-profile-card"]) {
      const single = readFileSync(path.join(root, `ui/src/${slug}-directions/frames/LabToolbar.tsx`), "utf8");
      assert.ok(!single.includes("surfaces</"), `${slug}: no surfaces row`);
      assert.ok(!single.includes('label="Surface"'), `${slug}: no Surface control`);
      assert.ok(!single.includes("VIEW_OPTIONS"), `${slug}: no VIEW_OPTIONS`);
      assert.ok(single.includes('<span className="hidden lg:inline">{LEGEND}</span>'), `${slug}: legend in row 1`);
    }
    for (const slug of Object.keys(SHAPES)) {
      const toolbar = readFileSync(path.join(root, `ui/src/${slug}-directions/frames/LabToolbar.tsx`), "utf8");
      assert.ok(toolbar.includes("const MAX_KIT_DIGIT = Math.max(...Object.values(KIT_KEYS).map(Number));"), `${slug}: digit range from KIT_KEYS`);
      assert.ok(toolbar.includes("const LEGEND = `0–${MAX_KIT_DIGIT} kit · t theme · a animation`;"), `${slug}: legend derived`);
      assert.ok(!/0–\d/.test(toolbar), `${slug}: no baked digit range`);
    }
    const plan = results["inbox-row"].json();
    assert.deepEqual(plan.toolbar, { surfacesRow: false, views: ["board", "inbox"] });
  });

  it("puts the motion asset, rendered for its id, at the end of every exploration tokens.css", async () => {
    for (const slug of Object.keys(SHAPES)) {
      const registry = readRegistry(readFileSync(path.join(root, `ui/src/${slug}-directions/registry.ts`), "utf8"));
      for (const direction of registry.directions.filter((entry) => !entry.baseline)) {
        const css = readFileSync(path.join(root, `ui/src/${slug}-directions/directions/${direction.id}/tokens.css`), "utf8");
        const block = await motionBlockFor({ id: direction.id, prefix: direction.id.replace(/^d\d+-/, "") });
        assert.ok(css.endsWith(block), `${slug}/${direction.id} ends with the motion block`);
        assert.equal(css.match(/cubic-bezier\(/g).length, 1);
      }
    }
  });

  it("gives every exploration a MotionSpecimen with the hooks and resting angles, rendered in every surface body", () => {
    for (const slug of Object.keys(SHAPES)) {
      const registry = readRegistry(readFileSync(path.join(root, `ui/src/${slug}-directions/registry.ts`), "utf8"));
      for (const direction of registry.directions.filter((entry) => !entry.baseline)) {
        const dir = path.join(root, `ui/src/${slug}-directions/directions/${direction.id}`);
        const specimen = readFileSync(path.join(dir, "MotionSpecimen.tsx"), "utf8");
        for (const hook of ["data-front", "data-rotate", 'data-spread={spread}', "rotate: -14", "rotate: -5", "transformOrigin"]) assert.ok(specimen.includes(hook), `${direction.id}: ${hook}`);
        for (const surface of registry.surfaces) {
          const body = readFileSync(path.join(dir, `${surface.id.charAt(0).toUpperCase()}${surface.id.slice(1).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())}Body.tsx`), "utf8");
          assert.ok(body.includes("<MotionSpecimen item={item} />"));
          assert.ok(body.includes(`data-lab-stub="${direction.id}-${surface.id}"`));
        }
      }
      for (const surface of registry.surfaces) {
        const frame = readFileSync(path.join(root, `ui/src/${slug}-directions/frames/${surface.id.charAt(0).toUpperCase()}${surface.id.slice(1).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())}Frame.tsx`), "utf8");
        assert.ok(frame.includes(`data-lab-stub="frame-${surface.id}"`));
        const today = readFileSync(path.join(root, `ui/src/${slug}-directions/directions/today/${surface.id.charAt(0).toUpperCase()}${surface.id.slice(1).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())}Body.tsx`), "utf8");
        assert.ok(today.includes(`data-lab-stub="today-${surface.id}"`));
      }
    }
  });

  it("writes no comments and no file of 600 lines or more", () => {
    const files = [...walk(path.join(root, "ui/src")), ...walk(path.join(root, "ui/storybook")), ...readdirSync(path.join(root, "ui")).map((name) => path.join(root, "ui", name)).filter((file) => /\.(html|mjs)$/.test(file))];
    assert.ok(files.length > 100);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.deepEqual(commentLines(text), [], `${path.relative(root, file)} has comment lines`);
      assert.ok(lineCount(text) < MAX_LINES, `${path.relative(root, file)} is under ${MAX_LINES} lines`);
    }
  });

  it("registers the story with the literal paperclip block last and the stable exports", () => {
    const story = readFileSync(path.join(root, "ui/storybook/stories/design-proposals/composer-directions.stories.tsx"), "utf8");
    assert.ok(story.includes('id: "design-composer-directions"'));
    assert.ok(story.includes('title: "Design proposals/Components/Composer directions/Compare"'));
    assert.ok(story.includes('status: "proposed"') && story.includes('home: "design-proposals"') && story.includes('implementation: "prototype"') && story.includes('boundary: "fixtures"'));
    assert.ok(story.includes("exception: \"Design directory entry for Composer: the shipped baseline and 3 proposed directions compared on static mocks of Task-thread and Right-panel.\""));
    assert.ok(/paperclip: \{[\s\S]*?\n    \},\n  \},\n\} satisfies Meta/.test(story), "paperclip is the last parameter");
    for (const name of ["Compare", "Today", "D1", "D2", "D3", "TodayProductionPalette"]) assert.ok(new RegExp(`^export const ${name}: Story`, "m").test(story), name);
    assert.ok(story.includes("parameters: { designProposalTheme: false }"));
    const two = readFileSync(path.join(root, "ui/storybook/stories/design-proposals/inbox-row-directions.stories.tsx"), "utf8");
    assert.ok(!two.includes("export const D3"));
  });

  it("adds two launch entries per lab and one gitignore line after the anchor", () => {
    const launch = JSON.parse(readFileSync(path.join(root, ".claude/launch.json"), "utf8"));
    const names = launch.configurations.map((entry) => entry.name);
    assert.deepEqual(names, ["paperclip", "composer-directions-dev", "composer-directions", "inbox-row-directions-dev", "inbox-row-directions", "agent-profile-card-directions-dev", "agent-profile-card-directions"]);
    const dev = launch.configurations.find((entry) => entry.name === "composer-directions-dev");
    assert.deepEqual(dev, { name: "composer-directions-dev", runtimeExecutable: "/bin/sh", runtimeArgs: ["-c", "cd ui && npx vite --config vite.composer-directions.config.mjs --port 5200 --strictPort"], port: 5200 });
    const preview = launch.configurations.find((entry) => entry.name === "composer-directions");
    assert.ok(preview.runtimeArgs[1].startsWith("cd ui && export COMPOSER_DIRECTIONS_OUT_DIR=node_modules/.composer-directions-dist && npx vite build"));
    assert.equal(preview.port, 5210);
    const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8").split("\n");
    assert.equal(gitignore.indexOf("dist-flow-preview/") + 1, gitignore.indexOf("ui/dist-agent-profile-card-directions/"));
    assert.ok(gitignore.includes("ui/dist-composer-directions/"));
  });

  it("refuses to scaffold over an existing lab and rolls nothing back", () => {
    const launchBefore = readFileSync(path.join(root, ".claude/launch.json"), "utf8");
    const again = run(["new", ...SHAPES.composer, "--skip-verify"], { root });
    assert.equal(again.code, 1);
    assert.match(again.out, /already exists/);
    assert.equal(readFileSync(path.join(root, ".claude/launch.json"), "utf8"), launchBefore);
  });

  it("lists the labs it finds", () => {
    const listed = run(["list", "--json"], { root });
    assert.equal(listed.code, 0, listed.out);
    const rows = listed.json();
    assert.deepEqual(rows.map((row) => row.slug).sort(), ["agent-profile-card", "composer", "inbox-row"]);
    assert.deepEqual(rows.find((row) => row.slug === "composer").ports, { dev: 5200, preview: 5210 });
  });

  it("passes check without verification and adds a direction through the registry", () => {
    const checked = run(["check", "--slug", "inbox-row", "--skip-verify"], { root });
    assert.equal(checked.code, 0, checked.out);
    assert.match(checked.out, /check: ok/);
    const added = run(["add-direction", "--slug", "inbox-row", "--name", "Bold", "--skip-verify"], { root });
    assert.equal(added.code, 0, added.out);
    const registry = readRegistry(readFileSync(path.join(root, "ui/src/inbox-row-directions/registry.ts"), "utf8"));
    assert.deepEqual(registry.directions.map((direction) => direction.id), ["d1-refine", "d2-rethink", "d3-bold", "today"]);
    assert.ok(existsSync(path.join(root, "ui/src/inbox-row-directions/directions/d3-bold/tokens.css")));
    assert.ok(existsSync(path.join(root, "ui/src/inbox-row-directions/directions/d3-bold/InboxBody.tsx")));
    const story = readFileSync(path.join(root, "ui/storybook/stories/design-proposals/inbox-row-directions.stories.tsx"), "utf8");
    assert.ok(story.includes('export const D3: Story = { name: "3.Bold", args: { direction: "d3-bold" } };\nexport const TodayProductionPalette'));
    const fourth = run(["add-direction", "--slug", "inbox-row", "--name", "Fourth", "--skip-verify"], { root });
    assert.equal(fourth.code, 1);
    assert.match(fourth.out, /--force-count/);
    const forced = run(["add-direction", "--slug", "inbox-row", "--name", "Fourth", "--skip-verify", "--force-count"], { root });
    assert.equal(forced.code, 0, forced.out);
    assert.ok(readFileSync(path.join(root, "ui/src/inbox-row-directions/registry.ts"), "utf8").includes("  allowMore: true,\n  allow: [],"));
    const strict = run(["check", "--slug", "inbox-row", "--strict", "--skip-verify"], { root });
    assert.equal(strict.code, 1);
    assert.match(strict.out, /scaffold stub/);
  });

  it("flags a data-lab-anim rule outside a direction's tokens.css", () => {
    const labCss = path.join(root, "ui/src/inbox-row-directions/lab.css");
    const original = readFileSync(labCss, "utf8");
    try {
      writeFileSync(labCss, `${original}html[data-lab-anim="1"] .x { transform: none; }\n`);
      const checked = run(["check", "--slug", "inbox-row", "--skip-verify", "--json"], { root });
      assert.equal(checked.code, 1);
      assert.deepEqual(checked.json().errors, ["ui/src/inbox-row-directions/lab.css: data-lab-anim rules belong in directions/<id>/tokens.css"]);
    } finally {
      writeFileSync(labCss, original);
    }
  });

  it("in mode B derives the Compare status from the registry stages and reports notRun as JSON", () => {
    const catalog = path.join(root, "scripts/storybook-catalog.mjs");
    const registryFile = path.join(root, "ui/src/agent-profile-card-directions/registry.ts");
    const storyFile = path.join(root, "ui/storybook/stories/design-proposals/agent-profile-card-directions.stories.tsx");
    const originals = Object.fromEntries([catalog, registryFile, storyFile].map((file) => [file, readFileSync(file, "utf8")]));
    const setStages = (stages) => {
      let text = originals[registryFile];
      for (const [id, stage] of Object.entries(stages)) text = text.replace(new RegExp(`(\\{ id: "${id}", [^\\n]*stage: ")proposed(" \\},)`), `$1${stage}$2`);
      writeFileSync(registryFile, text);
    };
    const setStory = (status, replacement) => {
      let text = originals[storyFile].replace('status: "proposed",', `status: "${status}",`);
      if (replacement) text = text.replace("      notes: ", `      replacement: ${JSON.stringify(replacement)},\n      notes: `);
      writeFileSync(storyFile, text);
    };
    const check = (slug = "agent-profile-card") => {
      const result = run(["check", "--slug", slug, "--skip-verify", "--json"], { root });
      return { code: result.code, ...result.json() };
    };
    try {
      writeFileSync(catalog, "nothing here\n");
      assert.equal(check().code, 0, "all proposed: proposed");
      assert.deepEqual(check().notRun, NOT_RUN);
      setStages({ "d1-refine": "current" });
      assert.equal(check().code, 0, "one current, others proposed: still proposed");
      setStages({ "d1-refine": "current", "d2-rework": "adopted", "d3-rethink": "historical" });
      assert.equal(check().code, 0, "an adopted exploration keeps the story proposed");
      setStages({ "d1-refine": "current", "d2-rework": "current", "d3-rethink": "current" });
      let result = check();
      assert.equal(result.code, 1);
      assert.deepEqual(result.errors, [`ui/storybook/stories/design-proposals/agent-profile-card-directions.stories.tsx: status should be "current" (mode B, lab stage current)`]);
      setStory("current");
      assert.equal(check().code, 0, "every exploration current: current");
      setStages({ "d1-refine": "current", "d2-rework": "historical", "d3-rethink": "historical" });
      assert.equal(check().code, 0, "the shipped one current, the rest retired: current");
      setStages({ "d1-refine": "historical", "d2-rework": "historical", "d3-rethink": "historical" });
      result = check();
      assert.equal(result.code, 1);
      assert.match(result.errors[0], /status should be "historical" \(mode B, lab stage historical\)/);
      setStory("historical");
      result = check();
      assert.equal(result.code, 1);
      assert.match(result.errors[0], /status "historical" needs replacement/);
      setStory("historical", "ui/storybook/stories/design-proposals/nowhere.stories.tsx");
      result = check();
      assert.equal(result.code, 1);
      assert.match(result.errors[0], /replacement ui\/storybook\/stories\/design-proposals\/nowhere\.stories\.tsx does not exist/);
      setStory("historical", "ui/storybook/stories/design-proposals/composer-directions.stories.tsx");
      assert.equal(check().code, 0, "every exploration historical with a replacement: historical");
      assert.equal(check("composer").code, 0, "a replacement naming another lab's story is not that lab's slug leaking");
      writeFileSync(catalog, originals[catalog]);
      result = check();
      assert.equal(result.code, 1);
      assert.match(result.errors[0], /status should be "proposed" \(mode A, lab stage historical\)/);
    } finally {
      for (const [file, text] of Object.entries(originals)) writeFileSync(file, text);
    }
  });
});

describe("review fixes", () => {
  it("quotes hyphenated surface ids so kit.ts and SurfaceView.tsx parse", () => {
    const root = makeRoot();
    try {
      const result = run(["new", "--slug", "hyphen", "--surfaces", "right-panel:Right-panel:434@tasks,thread:Task-thread:960@tasks", "--directions", "2", "--skip-verify"], { root });
      assert.equal(result.code, 0, result.out);
      const kit = readFileSync(path.join(root, "ui/src/hyphen-directions/kit.ts"), "utf8");
      const view = readFileSync(path.join(root, "ui/src/hyphen-directions/frames/SurfaceView.tsx"), "utf8");
      assert.match(kit, /  "right-panel": \{ items: LabRecord\[\] \};/);
      assert.match(view, /  "right-panel": RightPanelFrame,/);
      const esbuild = createRequire(path.join(REPO_ROOT, "ui/package.json"))("esbuild");
      for (const [file, source] of [["kit.ts", kit], ["SurfaceView.tsx", view]]) {
        assert.doesNotThrow(() => esbuild.transformSync(source, { loader: file.endsWith("x") ? "tsx" : "ts", jsx: "automatic" }), file);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back written files and launch entries when a shared-file edit throws", () => {
    const root = makeRoot();
    try {
      const launchBefore = readFileSync(path.join(root, ".claude/launch.json"), "utf8");
      rmSync(path.join(root, ".gitignore"));
      mkdirSync(path.join(root, ".gitignore"));
      const result = run(["new", ...SHAPES.composer.slice(0), "--skip-verify"], { root });
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /Rolled back every written path/);
      assert.equal(existsSync(path.join(root, "ui/src/composer-directions")), false);
      assert.equal(existsSync(path.join(root, "ui/composer-directions.html")), false);
      assert.equal(readFileSync(path.join(root, ".claude/launch.json"), "utf8"), launchBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses add-direction once the slot props no longer match the placeholder", () => {
    const root = makeRoot();
    try {
      assert.equal(run(["new", ...SHAPES.composer, "--skip-verify"], { root }).code, 0);
      const kitFile = path.join(root, "ui/src/composer-directions/kit.ts");
      writeFileSync(kitFile, readFileSync(kitFile, "utf8").replace('"thread": { items: LabRecord[] };', '"thread": { workProducts: string[] };'));
      const result = run(["add-direction", "--slug", "composer", "--name", "Bold", "--force-count", "--skip-verify"], { root });
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /no longer match the scaffold's placeholder \(thread\)/);
      assert.equal(existsSync(path.join(root, "ui/src/composer-directions/directions/d4-bold")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dry runs against the real repo", () => {
  it("validates capabilities through the feature map and refuses unknown ids", () => {
    const ok = run(["new", "--slug", "zz-dry", "--title", "Dry", "--surfaces", "a:A:960@tasks", "--directions", "2", "--capabilities", "tasks/create", "--dry-run", "--json"], { root: REPO_ROOT });
    assert.equal(ok.code, 0, ok.out);
    const plan = ok.json();
    assert.deepEqual(plan.lab.capabilities, ["tasks/create"]);
    assert.equal(plan.lab.exception, null);
    assert.ok(!existsSync(path.join(REPO_ROOT, "ui/src/zz-dry-directions")));
    const bad = run(["new", "--slug", "zz-dry", "--title", "Dry", "--surfaces", "a:A:960@tasks", "--directions", "2", "--capabilities", "tasks/nope", "--dry-run"], { root: REPO_ROOT });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /unknown capabilities/);
  });

  it("renders every template in memory for a repo-rooted context", async () => {
    const ctx = buildContext({ slug: "zz-mem", surfaces: "a:A:960@tasks,b:B:434@artifacts", directions: "3" }, { root: REPO_ROOT, ports: { dev: 5200, preview: 5210 } });
    const files = await renderLab(ctx);
    assert.equal(files.size, 47);
    assert.ok(files.get("ui/src/zz-mem-directions/registry.ts").includes(directionLine(ctx.directions[0])));
    const text = files.get("ui/src/zz-mem-directions/registry.ts");
    const next = insertDirection(text, deriveDirection(4, "Four"), { allowMore: true });
    assert.deepEqual(readRegistry(next).directions.map((direction) => direction.id), ["d1-refine", "d2-rework", "d3-rethink", "d4-four", "today"]);
    assert.throws(() => insertDirection(text.replace("baseline: true, ", ""), deriveDirection(4, "Four")), /baseline/);
  });
});
