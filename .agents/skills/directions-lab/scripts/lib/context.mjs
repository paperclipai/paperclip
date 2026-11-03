import { execFileSync } from "node:child_process";
import { UsageError } from "./args.mjs";

export const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const NAVS = ["tasks", "artifacts", "other"];
export const GROUPS = ["Components", "Pages", "Layouts", "Patterns"];
export const DEFAULT_NAMES = { 2: ["Refine", "Rethink"], 3: ["Refine", "Rework", "Rethink"] };
export const PLACEHOLDER_TAGLINES = {
  Refine: "Tokens and spacing, same structure",
  Rework: "New components, same layout",
  Rethink: "New layout",
};
export const TODAY = { id: "today", key: "0", digit: 0, name: "0.Today", label: "Today", tagline: "What ships now", baseline: true, stage: "shipped" };
export const SKILL_VERSION = "1";
export const MAX_BOARD_CELLS = 8;

export const pascal = (value) => value.split(/[-_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
export const upperSnake = (value) => value.replace(/-/g, "_").toUpperCase();
export const kebab = (value) =>
  value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
export const sentenceCase = (slug) => {
  const words = slug.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function parseSurfaces(text) {
  if (!text) throw new UsageError("--surfaces is required (id:Label:width@nav,...)");
  const surfaces = text.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const match = /^([a-z][a-z0-9-]*):([^:@]+):(\d+)@([a-z]+)$/.exec(entry);
    if (!match) throw new UsageError(`surface "${entry}" must look like id:Label:width@nav`);
    const [, id, label, width, nav] = match;
    if (!NAVS.includes(nav)) throw new UsageError(`surface "${id}" nav "${nav}" must be one of ${NAVS.join("|")}`);
    if (Number(width) <= 0) throw new UsageError(`surface "${id}" width must be positive`);
    return deriveSurface({ id, label: label.trim(), width: Number(width), nav });
  });
  if (surfaces.length < 1 || surfaces.length > 6) throw new UsageError("1 to 6 surfaces");
  const ids = surfaces.map((surface) => surface.id);
  if (new Set(ids).size !== ids.length) throw new UsageError("surface ids must be unique");
  if (ids.includes("board")) throw new UsageError('"board" is the overview view and cannot be a surface id');
  return surfaces;
}

export function deriveSurface({ id, label, width, nav }) {
  const Pascal = pascal(id);
  return { id, label, width, nav, Pascal, UPPER: upperSnake(id), fixture: `${upperSnake(id)}_ITEMS`, body: `${Pascal}Body`, frame: `${Pascal}Frame` };
}

export function deriveDirection(digit, name) {
  const label = name.trim();
  if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(label)) throw new UsageError(`direction name "${label}" must be letters, digits and spaces, starting with a letter`);
  const prefix = kebab(label);
  return {
    id: `d${digit}-${prefix}`,
    key: String(digit),
    digit,
    name: `${digit}.${label}`,
    label,
    tagline: PLACEHOLDER_TAGLINES[label] ?? `Direction ${digit}`,
    prefix,
    stage: "proposed",
  };
}

export function parseDirections(flags) {
  const count = Number(flags.directions);
  if (!Number.isInteger(count) || count < 2 || count > 9) throw new UsageError("--directions must be 2 or 3 (4-9 with --force-count)");
  if (count > 3 && !flags["force-count"]) throw new UsageError(`--directions ${count} needs --force-count (2 or 3 is the house rule)`);
  const names = flags.names ? flags.names.split(",").map((name) => name.trim()).filter(Boolean) : DEFAULT_NAMES[count];
  if (!names) throw new UsageError(`--names is required for ${count} directions`);
  if (names.length !== count) throw new UsageError(`--names lists ${names.length} names for ${count} directions`);
  const directions = names.map((name, index) => deriveDirection(index + 1, name));
  const prefixes = directions.map((direction) => direction.prefix);
  if (new Set(prefixes).size !== prefixes.length) throw new UsageError("direction names must be distinct");
  return directions;
}

export function parseCompany(text = "acmehats:ACM") {
  const match = /^([a-z][a-z0-9-]*):([A-Z][A-Z0-9]{0,5})$/.exec(text);
  if (!match) throw new UsageError('--company must look like name:PREFIX (lowercase name, upper-case prefix), e.g. acmehats:ACM');
  const [, name, issuePrefix] = match;
  return { id: `company-${name}`, name, issuePrefix };
}

export function resolveLanding(flag = "auto", directions, surfaces) {
  const cells = (directions.length + 1) * surfaces.length;
  if (flag === "auto") return { direction: "all", view: cells <= MAX_BOARD_CELLS ? "board" : surfaces[0].id };
  if (flag === "all") return { direction: "all", view: "board" };
  if (flag === "today") return { direction: "today", view: surfaces[0].id };
  const direction = directions.find((entry) => entry.id === flag);
  if (!direction) throw new UsageError(`--landing "${flag}" is not auto, all, today or a direction id (${directions.map((entry) => entry.id).join(", ")})`);
  return { direction: direction.id, view: surfaces[0].id };
}

export function runtimeCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function shellTasks(company) {
  return [
    { identifier: `${company.issuePrefix}-1`, title: "Paperclip onboarding" },
    { identifier: `${company.issuePrefix}-2`, title: `Develop ${company.name} brand strategy and designer brief` },
    { identifier: `${company.issuePrefix}-3`, title: `Create visual directions and first ${company.name} brand deck` },
  ];
}

export function joinLabels(labels) {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function buildContext(flags, { root, ports, capabilities = [], today = new Date() }) {
  const slug = flags.slug;
  if (!slug || !SLUG_PATTERN.test(slug)) throw new UsageError("--slug must be kebab-case: lower-case letters, digits and single hyphens");
  if (slug.endsWith("-directions")) throw new UsageError('--slug must not end with "-directions"; the suffix is added');
  const title = (flags.title ?? sentenceCase(slug)).trim();
  if (!title) throw new UsageError("--title must not be empty");
  const group = flags.group ?? "Components";
  if (!GROUPS.includes(group)) throw new UsageError(`--group must be one of ${GROUPS.join("|")}`);
  const surfaces = parseSurfaces(flags.surfaces);
  const directions = parseDirections(flags);
  const company = parseCompany(flags.company);
  const landing = resolveLanding(flags.landing, directions, surfaces);
  return assembleContext({ root, slug, title, group, surfaces, directions, company, landing, ports, capabilities, forceCount: Boolean(flags["force-count"]), today });
}

export function assembleContext({ root, slug, title, group, surfaces, directions, company, landing, ports, capabilities, forceCount, today = new Date(), provenance }) {
  const SLUG = upperSnake(slug);
  const kits = [...directions, TODAY];
  const cells = kits.length * surfaces.length;
  const labels = surfaces.map((surface) => surface.label);
  return {
    slug,
    SLUG,
    title,
    group,
    labDir: `ui/src/${slug}-directions`,
    entry: `${slug}-directions.html`,
    configFile: `vite.${slug}-directions.config.mjs`,
    storyId: `design-${slug}-directions`,
    storyFile: `ui/storybook/stories/design-proposals/${slug}-directions.stories.tsx`,
    envOutDir: `${SLUG}_DIRECTIONS_OUT_DIR`,
    envPort: `${SLUG}_DIRECTIONS_PORT`,
    buildDefine: `__${SLUG}_DIRECTIONS_BUILD_COMMIT__`,
    distDir: `ui/dist-${slug}-directions/`,
    staticDir: `node_modules/.${slug}-directions-dist`,
    ports,
    directions,
    today: TODAY,
    kits,
    surfaces,
    multiSurface: surfaces.length > 1,
    cells,
    landing,
    capabilities,
    exception: `Design directory entry for ${title}: the shipped baseline and ${directions.length} proposed directions compared on static mocks of ${joinLabels(labels)}.`,
    notes: `Controls pick a direction kit and a surface. Today mounts the shipped ${title} components behind the lab's fetch stub with the ${company.name} fixture world; the other kits are lab components. Frames are static mocks of the product chrome; nothing here establishes production behaviour or access checks.`,
    company,
    tasks: shellTasks(company),
    tag: `[${slug}-directions]`,
    publicUrl: `https://paperclip-${slug}-directions.vercel.app`,
    vercelProject: `paperclip-${slug}-directions`,
    forceCount: Boolean(forceCount),
    provenance: provenance ?? { runtimeCommit: runtimeCommit(root), skillVersion: SKILL_VERSION, createdAt: today.toISOString().slice(0, 10) },
  };
}
