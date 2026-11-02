import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PLACEHOLDER_TAGLINES } from "./context.mjs";
import { detectMode, expectedStoryStatus, labStage } from "./modes.mjs";
import { readRegistry } from "./registry-edit.mjs";
import { describeFailure, runStep } from "./verify.mjs";
import { commentLines, lineCount, MAX_LINES } from "./write.mjs";

export const DENY_LIST = [
  "artifact-directions",
  "LabArtifact",
  "LabGroup",
  "LabKind",
  "LabRun",
  "GalleryFrame",
  "KindsSheet",
  "KIND_SPECIMENS",
  "STACK_SPECIMENS",
  "d5-v1-mvp",
  "--v1-",
  "ArtifactCard",
  "isShippedNestingWarning",
  "Interface Craft",
  "2096:",
  "2129:",
];

export const STORY_EXPORTS = ["Compare", "Today", "TodayProductionPalette"];

export const NOT_RUN = ["pnpm build-storybook (not part of check --run; run it or report why not)", "pnpm -r typecheck (needs the Rust toolchain for paperclip-runner)"];

function walk(dir, filter = () => true) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(file, filter);
    return filter(file) ? [file] : [];
  });
}

const CODE = /\.(ts|tsx|css|cjs|mjs|html)$/;
const DIRECTION_TOKENS = /\/directions\/[^/]+\/tokens\.css$/;
const REPLACEMENT_LINE = /^\s*replacement: "[^"]*",?$/;

const namesOutsideReplacement = (text, term) => text.split("\n").some((line) => !REPLACEMENT_LINE.test(line) && line.includes(term));

export function labPaths(root, slug) {
  return {
    labDir: path.join(root, `ui/src/${slug}-directions`),
    entry: path.join(root, `ui/${slug}-directions.html`),
    config: path.join(root, `ui/vite.${slug}-directions.config.mjs`),
    story: path.join(root, `ui/storybook/stories/design-proposals/${slug}-directions.stories.tsx`),
    launch: path.join(root, ".claude/launch.json"),
    gitignore: path.join(root, ".gitignore"),
  };
}

export function checkLab(root, slug, { strict = false, run = false, skipVerify = false } = {}) {
  const errors = [];
  const warnings = [];
  const paths = labPaths(root, slug);
  const registryFile = path.join(paths.labDir, "registry.ts");
  if (!existsSync(registryFile)) return { errors: [`no lab at ui/src/${slug}-directions (registry.ts missing)`], warnings, verification: [], notRun: NOT_RUN };
  const registry = readRegistry(readFileSync(registryFile, "utf8"), path.relative(root, registryFile));
  const relative = (file) => path.relative(root, file);

  const kitDirs = readdirSync(path.join(paths.labDir, "directions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const ids = registry.directions.map((direction) => direction.id).sort();
  if (JSON.stringify(kitDirs) !== JSON.stringify(ids)) errors.push(`directions/ holds [${kitDirs.join(", ")}] but the registry lists [${ids.join(", ")}]`);
  for (const direction of registry.directions) {
    const index = path.join(paths.labDir, "directions", direction.id, "index.tsx");
    if (!existsSync(index)) continue;
    const text = readFileSync(index, "utf8");
    if (!text.includes(`id: ${JSON.stringify(direction.id)}`)) errors.push(`${relative(index)}: kit.id is not ${JSON.stringify(direction.id)}`);
    if (!text.includes(`name: ${JSON.stringify(direction.name)}`)) errors.push(`${relative(index)}: kit.name is not ${JSON.stringify(direction.name)}`);
    const tokens = path.join(paths.labDir, "directions", direction.id, "tokens.css");
    if (!direction.baseline && !existsSync(tokens)) errors.push(`${relative(tokens)}: every exploration carries a tokens.css`);
    if (direction.baseline && existsSync(tokens)) errors.push(`${relative(tokens)}: Today carries no tokens.css`);
    if (!direction.baseline && Object.values(PLACEHOLDER_TAGLINES).includes(direction.tagline)) warnings.push(`${direction.id}: tagline "${direction.tagline}" is the scaffold placeholder`);
    if (!direction.baseline && /^Direction \d$/.test(direction.tagline)) warnings.push(`${direction.id}: tagline "${direction.tagline}" is the scaffold placeholder`);
  }
  const keys = registry.directions.map((direction) => direction.key);
  if (new Set(keys).size !== keys.length || keys.some((key) => !/^\d$/.test(key))) errors.push("direction keys must be unique single digits");
  const baselines = registry.directions.filter((direction) => direction.baseline);
  if (baselines.length !== 1 || baselines[0].id !== "today") errors.push("exactly one baseline direction, today");

  const labFiles = [...walk(paths.labDir, (file) => CODE.test(file)), paths.entry, paths.config, paths.story].filter(existsSync);
  const allow = new Set(registry.allow);
  for (const file of labFiles) {
    const text = readFileSync(file, "utf8");
    const comments = commentLines(text);
    if (comments.length) errors.push(`${relative(file)}: comment line(s) at ${comments.slice(0, 5).join(", ")}`);
    const lines = lineCount(text);
    if (lines >= MAX_LINES) errors.push(`${relative(file)}: ${lines} lines reaches the ${MAX_LINES}-line limit`);
    for (const term of DENY_LIST) if (!allow.has(term) && text.includes(term)) errors.push(`${relative(file)}: carries "${term}" from the artifact lab`);
    if (strict) {
      const stubs = [...text.matchAll(/data-lab-stub="([^"]+)"/g)].map((match) => match[1]);
      if (stubs.length) errors.push(`${relative(file)}: scaffold stub(s) still present: ${[...new Set(stubs)].join(", ")}`);
    }
    if (/\.(css|html)$/.test(file) && !DIRECTION_TOKENS.test(file) && text.includes("data-lab-anim")) errors.push(`${relative(file)}: data-lab-anim rules belong in directions/<id>/tokens.css`);
  }

  const allowedSlugFiles = new Set([...labFiles, paths.launch, paths.gitignore].map(relative));
  const slugTerm = `${slug}-directions`;
  const scanRoots = [path.join(root, "ui/src"), path.join(root, "ui/storybook"), path.join(root, "ui")];
  const seen = new Set();
  for (const scanRoot of scanRoots) {
    const files = scanRoot === path.join(root, "ui") ? readdirSync(scanRoot).map((name) => path.join(scanRoot, name)).filter((file) => statSync(file).isFile()) : walk(scanRoot, (file) => CODE.test(file) || file.endsWith(".json"));
    for (const file of files) {
      if (seen.has(file) || !CODE.test(file)) continue;
      seen.add(file);
      if (allowedSlugFiles.has(relative(file))) continue;
      if (namesOutsideReplacement(readFileSync(file, "utf8"), slugTerm)) errors.push(`${relative(file)}: names ${slugTerm} outside the lab`);
    }
  }

  if (existsSync(paths.story)) {
    const story = readFileSync(paths.story, "utf8");
    if (!story.includes(`id: ${JSON.stringify(registry.storyId)}`)) errors.push(`${relative(paths.story)}: meta id is not ${registry.storyId}`);
    for (const name of STORY_EXPORTS) if (!new RegExp(`^export const ${name}: Story`, "m").test(story)) errors.push(`${relative(paths.story)}: export ${name} is missing`);
    for (const direction of registry.directions.filter((entry) => !entry.baseline)) {
      if (!new RegExp(`^export const D${direction.key}: Story`, "m").test(story)) errors.push(`${relative(paths.story)}: export D${direction.key} is missing`);
    }
    const parameters = /parameters: \{([\s\S]*?)\n  \},\n\} satisfies Meta/.exec(story);
    if (!parameters) errors.push(`${relative(paths.story)}: cannot find the meta parameters block`);
    else {
      const keys = [...parameters[1].matchAll(/^    ([a-zA-Z]+): /gm)].map((match) => match[1]);
      if (keys[keys.length - 1] !== "paperclip") errors.push(`${relative(paths.story)}: paperclip must be the last parameter (found ${keys.join(", ")})`);
      const mode = detectMode(root);
      const stage = labStage(registry.directions);
      const expected = expectedStoryStatus(mode, stage);
      if (!parameters[1].includes(`status: "${expected}"`)) errors.push(`${relative(paths.story)}: status should be "${expected}" (mode ${mode}, lab stage ${stage})`);
      if (expected === "historical") {
        const replacement = /\breplacement: "([^"]+)"/.exec(parameters[1]);
        if (!replacement) errors.push(`${relative(paths.story)}: status "historical" needs replacement: "<repo-relative .stories.tsx>" naming the successor story`);
        else if (!existsSync(path.join(root, replacement[1]))) errors.push(`${relative(paths.story)}: replacement ${replacement[1]} does not exist`);
      }
    }
  } else errors.push(`${relative(paths.story)}: story file is missing`);

  if (existsSync(paths.launch)) {
    const names = JSON.parse(readFileSync(paths.launch, "utf8")).configurations.map((entry) => entry.name);
    for (const name of [`${slug}-directions-dev`, `${slug}-directions`]) if (!names.includes(name)) errors.push(`.claude/launch.json: entry ${name} is missing`);
  } else errors.push(".claude/launch.json is missing");
  if (!existsSync(paths.gitignore) || !readFileSync(paths.gitignore, "utf8").split("\n").includes(`ui/dist-${slug}-directions/`)) errors.push(`.gitignore: ui/dist-${slug}-directions/ is missing`);

  const verification = [];
  if (!skipVerify && errors.length === 0) {
    const motion = runStep("motion contract", "npx", ["vitest", "run", `src/${slug}-directions/motion-contract.test.ts`], { cwd: path.join(root, "ui") });
    verification.push(motion);
    if (!motion.ok) errors.push(describeFailure(motion));
    if (run && motion.ok) {
      const SLUG = slug.replace(/-/g, "_").toUpperCase();
      const steps = [
        ["lab vitest", "npx", ["vitest", "run", `src/${slug}-directions`], "ui", {}],
        ["storybook catalog", "node", ["scripts/storybook-catalog.mjs", "--check"], ".", {}],
        ["token gates", "pnpm", ["run", "check:token-gates"], ".", {}],
        ["lab vite build", "npx", ["vite", "build", "--config", `vite.${slug}-directions.config.mjs`], "ui", { [`${SLUG}_DIRECTIONS_OUT_DIR`]: `node_modules/.${slug}-directions-dist` }],
        ["ui typecheck", "pnpm", ["typecheck"], "ui", {}],
      ];
      for (const [label, command, args, cwd, env] of steps) {
        const result = runStep(label, command, args, { cwd: path.join(root, cwd), env });
        verification.push(result);
        if (!result.ok) {
          errors.push(describeFailure(result));
          break;
        }
      }
    }
  }
  return { errors, warnings, verification, registry, notRun: NOT_RUN };
}

export function verificationBlock(verification, { skipped = NOT_RUN } = {}) {
  const lines = ["## Verification", ""];
  for (const result of verification) lines.push(`- ${result.ok ? "Passed" : "Failed"}: \`cd ${path.basename(result.cwd) === "ui" ? "ui" : "."} && ${result.command}\``);
  for (const reason of skipped) lines.push(`- Not run: ${reason}`);
  return lines.join("\n");
}
