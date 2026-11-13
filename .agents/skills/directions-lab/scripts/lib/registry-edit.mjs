import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export class RegistryShapeError extends Error {}

const DIRECTION_LINE = /^ {4}\{ id: "([^"]+)", key: "(\d)", name: "([^"]+)", tagline: "((?:[^"\\]|\\.)*)"(, baseline: true)?, stage: "([a-z]+)" \},$/;
const SURFACE_LINE = /^ {4}\{ id: "([^"]+)", label: "((?:[^"\\]|\\.)*)", width: (\d+), nav: "([a-z]+)" \},$/;

function field(text, name, pattern, file) {
  const match = new RegExp(`^  ${name}: ${pattern},$`, "m").exec(text);
  if (!match) throw new RegistryShapeError(`${file}: cannot find the generator-owned line "  ${name}: ..."; the registry was hand-edited past what the generator recognises`);
  return match[1];
}

function block(text, name, file) {
  const start = text.indexOf(`  ${name}: [\n`);
  if (start === -1) throw new RegistryShapeError(`${file}: cannot find the generator-owned "  ${name}: [" array`);
  const end = text.indexOf("\n  ],\n", start);
  if (end === -1) throw new RegistryShapeError(`${file}: the "${name}" array has no "  ]," close on its own line`);
  const inner = text.slice(start + `  ${name}: [\n`.length, end);
  return { start, end: end + "\n  ],\n".length, lines: inner.split("\n") };
}

export function readRegistry(text, file = "registry.ts") {
  const slug = field(text, "slug", '"([^"]+)"', file);
  const title = field(text, "title", '"((?:[^"\\\\]|\\\\.)*)"', file);
  const storyId = field(text, "storyId", '"([^"]+)"', file);
  const group = field(text, "group", '"([^"]+)"', file);
  const landingRaw = field(text, "landing", '\\{ direction: "([^"]+)", view: "[^"]+" \\}', file);
  const landingView = /^  landing: \{ direction: "[^"]+", view: "([^"]+)" \},$/m.exec(text)[1];
  const directions = block(text, "directions", file).lines.map((line) => {
    const match = DIRECTION_LINE.exec(line);
    if (!match) throw new RegistryShapeError(`${file}: direction line not in generator form:\n${line}`);
    const [, id, key, name, tagline, baseline, stage] = match;
    return { id, key, name, tagline, baseline: Boolean(baseline), stage };
  });
  const surfaces = block(text, "surfaces", file).lines.map((line) => {
    const match = SURFACE_LINE.exec(line);
    if (!match) throw new RegistryShapeError(`${file}: surface line not in generator form:\n${line}`);
    const [, id, label, width, nav] = match;
    return { id, label, width: Number(width), nav };
  });
  const allowMatch = /^  allow: \[(.*)\],$/m.exec(text);
  const allow = allowMatch ? allowMatch[1].split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
  return { slug, title, storyId, group, landing: { direction: landingRaw, view: landingView }, directions, surfaces, allow, allowMore: /^  allowMore: true,$/m.test(text) };
}

export function directionLine(direction) {
  return `    { id: "${direction.id}", key: "${direction.key}", name: "${direction.name}", tagline: "${direction.tagline}", stage: "${direction.stage}" },`;
}

export function insertDirection(text, direction, { file = "registry.ts", allowMore = false } = {}) {
  const { lines, start, end } = block(text, "directions", file);
  const todayIndex = lines.findIndex((line) => DIRECTION_LINE.exec(line)?.[5]);
  if (todayIndex === -1) {
    throw new RegistryShapeError(`${file}: no baseline line in the directions array. Add this line by hand before the today entry:\n${directionLine(direction)}`);
  }
  const next = [...lines.slice(0, todayIndex), directionLine(direction), ...lines.slice(todayIndex)];
  let result = `${text.slice(0, start)}  directions: [\n${next.join("\n")}\n  ],\n${text.slice(end)}`;
  if (allowMore && !/^  allowMore: true,$/m.test(result)) {
    const allowLine = /^  allow: \[.*\],$/m.exec(result);
    if (!allowLine) throw new RegistryShapeError(`${file}: cannot find "  allow: [...]," to place allowMore before`);
    result = `${result.slice(0, allowLine.index)}  allowMore: true,\n${result.slice(allowLine.index)}`;
  }
  return result;
}

export const STORY_ANCHOR = "export const TodayProductionPalette: Story = {";

export const directionStoryLine = (direction) => `export const D${direction.key}: Story = { name: ${JSON.stringify(direction.name)}, args: { direction: ${JSON.stringify(direction.id)} } };`;

export function insertDirectionStory(text, direction, file = "stories.tsx") {
  const line = directionStoryLine(direction);
  if (text.includes(`export const D${direction.key}: Story`)) throw new RegistryShapeError(`${file}: export D${direction.key} already exists`);
  const anchor = text.indexOf(STORY_ANCHOR);
  if (anchor === -1) throw new RegistryShapeError(`${file}: cannot find "${STORY_ANCHOR}" to insert before. Add this line by hand after the last D<N> export:\n${line}`);
  return `${text.slice(0, anchor)}${line}\n${text.slice(anchor)}`;
}

export function findLabs(root) {
  const dir = path.join(root, "ui/src");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-directions") && existsSync(path.join(dir, entry.name, "registry.ts")))
    .map((entry) => {
      const file = path.join(dir, entry.name, "registry.ts");
      return { dir: `ui/src/${entry.name}`, file, registry: readRegistry(readFileSync(file, "utf8"), `ui/src/${entry.name}/registry.ts`) };
    });
}
