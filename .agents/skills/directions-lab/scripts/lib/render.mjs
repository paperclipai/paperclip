import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/templates");

async function template(name) {
  return import(pathToFileURL(path.join(TEMPLATE_ROOT, name)).href);
}

const LAB_FILES = [
  ["main.tsx", "main.tsx.mjs"],
  ["providers.tsx", "providers.tsx.mjs"],
  ["lab.css", "lab.css.mjs"],
  ["build-info.ts", "build-info.ts.mjs"],
  ["define-lab.ts", "define-lab.ts.mjs"],
  ["registry.ts", "registry.ts.mjs"],
  ["kit.ts", "kit.ts.mjs"],
  ["lab-state.ts", "lab-state.ts.mjs"],
  ["api-stub.ts", "api-stub.ts.mjs"],
  ["api-routes.ts", "api-routes.ts.mjs"],
  ["fixtures.ts", "fixtures.ts.mjs"],
  ["shot.cjs", "shot.cjs.mjs"],
  ["frames/Slot.tsx", "frames/Slot.tsx.mjs"],
  ["frames/LabToolbar.tsx", "frames/LabToolbar.tsx.mjs"],
  ["frames/Board.tsx", "frames/Board.tsx.mjs"],
  ["frames/AppShell.tsx", "frames/AppShell.tsx.mjs"],
  ["frames/SurfaceView.tsx", "frames/SurfaceView.tsx.mjs"],
  ["directions/today/index.tsx", "today/index.tsx.mjs"],
  ["directions/today/adapters.ts", "today/adapters.ts.mjs"],
  ["registry.test.ts", "tests/registry.test.ts.mjs"],
  ["lab-state.test.ts", "tests/lab-state.test.ts.mjs"],
  ["motion-contract.test.ts", "tests/motion-contract.test.ts.mjs"],
  ["today.test.tsx", "tests/today.test.tsx.mjs"],
  ["api-stub.test.ts", "tests/api-stub.test.ts.mjs"],
];

export async function renderDirection(ctx, direction) {
  const files = new Map();
  const dir = `${ctx.labDir}/directions/${direction.id}`;
  const index = await template("direction/index.tsx.mjs");
  const tokens = await template("direction/tokens.css.mjs");
  const specimen = await template("direction/MotionSpecimen.tsx.mjs");
  const body = await template("direction/SlotBody.tsx.mjs");
  files.set(`${dir}/index.tsx`, index.default(ctx, direction));
  files.set(`${dir}/tokens.css`, tokens.default(ctx, direction));
  files.set(`${dir}/MotionSpecimen.tsx`, specimen.default(ctx, direction));
  for (const surface of ctx.surfaces) files.set(`${dir}/${surface.body}.tsx`, body.default(ctx, direction, surface));
  return files;
}

export async function renderLab(ctx) {
  const files = new Map();
  const entry = await template("entry.html.mjs");
  const config = await template("vite.config.mjs.mjs");
  const story = await template("stories/compare.stories.tsx.mjs");
  const buildInfo = await template("build-info.ts.mjs");
  files.set(`ui/${ctx.entry}`, entry.default(ctx));
  files.set(`ui/${ctx.configFile}`, config.default(ctx));
  files.set(ctx.storyFile, story.default(ctx));
  files.set(`${ctx.labDir}/lab-env.d.ts`, buildInfo.envDts(ctx));
  for (const [target, name] of LAB_FILES) {
    const module = await template(name);
    files.set(`${ctx.labDir}/${target}`, module.default(ctx));
  }
  const frame = await template("frames/SurfaceFrame.tsx.mjs");
  const todayBody = await template("today/SlotBody.tsx.mjs");
  for (const surface of ctx.surfaces) {
    files.set(`${ctx.labDir}/frames/${surface.frame}.tsx`, frame.default(ctx, surface));
    files.set(`${ctx.labDir}/directions/today/${surface.body}.tsx`, todayBody.default(ctx, surface));
  }
  for (const direction of ctx.directions) for (const [target, content] of await renderDirection(ctx, direction)) files.set(target, content);
  return files;
}

export async function launchEntries(ctx) {
  const module = await template("launch-entries.json.mjs");
  return { entries: module.default(ctx), names: module.launchNames(ctx) };
}

export async function motionBlockFor(direction) {
  const module = await template("direction/tokens.css.mjs");
  return module.motionBlock(direction);
}
