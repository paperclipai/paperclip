#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featureIndex, sidebarLabel } from "./feature-map.mjs";
import { generateFeatureArtifacts, generatedRoot, writeArtifacts } from "./storybook-feature-index.mjs";
import { checkMaps } from "./check-maps.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const storyRoot = "ui/storybook/stories";
const statuses = ["current", "proposed", "historical", "mixed", "unreviewed"];
const implementations = ["production", "prototype", "mixed", "guide", "unreviewed"];
const boundaries = ["fixtures", "fixture-server", "static", "unreviewed"];
const annotationFields = new Set(["capabilities", "status", "implementation", "boundary", "notes", "home", "exception", "replacement"]);
const specialHomes = { overview: "Overview", "design-proposals": "Design proposals", foundations: "Foundations" };

function files(root, dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const name = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(root, name) : [name];
  }).sort();
}

function literal(node, label) {
  if (!node) throw new Error(`${label}: expected literal metadata`);
  if (["TSAsExpression", "TSSatisfiesExpression"].includes(node.type)) return literal(node.expression, label);
  if (["StringLiteral", "BooleanLiteral", "NumericLiteral"].includes(node.type)) return node.value;
  if (node.type === "ArrayExpression") return node.elements.map(element => literal(element, label));
  if (node.type === "ObjectExpression") {
    const result = {};
    for (const property of node.properties) {
      const key = property.key?.name ?? property.key?.value;
      if (property.type !== "ObjectProperty" || property.computed || typeof key !== "string" || Object.hasOwn(result, key) || key === "__proto__") {
        throw new Error(`${label}: metadata must use unique literal properties`);
      }
      result[key] = literal(property.value, label);
    }
    return result;
  }
  throw new Error(`${label}: metadata must be literal; expressions are not executed`);
}

function annotation(csf, file) {
  const parameters = csf._metaAnnotations.parameters;
  if (parameters?.type !== "ObjectExpression") throw new Error(`${file}: declare parameters.paperclip as literal metadata`);
  const matches = parameters.properties.filter(property => (property.key?.name ?? property.key?.value) === "paperclip");
  if (matches.length !== 1) throw new Error(`${file}: expected one parameters.paperclip annotation`);
  const property = matches[0];
  if (property.type !== "ObjectProperty" || property.computed) throw new Error(`${file}: paperclip must be a literal property`);
  if (parameters.properties.slice(parameters.properties.indexOf(property) + 1).some(property => property.type === "SpreadElement" || property.computed)) {
    throw new Error(`${file}: paperclip metadata must follow parameter spreads and computed properties`);
  }
  const value = literal(property.value, file);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${file}: paperclip metadata must be an object`);
  for (const key of Object.keys(value)) if (!annotationFields.has(key)) throw new Error(`${file}: unknown paperclip field ${key}`);
  return value;
}

export function scanStories(root = defaultRoot) {
  const require = createRequire(path.join(root, "ui/package.json"));
  const { loadCsf } = require("storybook/internal/csf-tools");
  return files(root, storyRoot).filter(file => /\.stories\.(ts|tsx|mdx)$/.test(file)).map(file => {
    const csf = loadCsf(readFileSync(path.join(root, file), "utf8"), { fileName: file, makeTitle: title => title }).parse();
    return { file, title: csf.meta.title, metaId: csf.meta.id, ids: csf.stories.map(story => story.id), plays: csf.stories.filter(story => story.__stats?.play).length, annotation: annotation(csf, file) };
  });
}

export function storyHome(entry) {
  return entry.home ?? (typeof entry.capabilities?.[0] === "string" ? entry.capabilities[0].split("/")[0] : undefined) ?? (entry.implementation === "guide" ? "overview" : "foundations");
}

export function catalogFromStories(stories, index) {
  const navigation = new Map(index.sections.flatMap(section => section.features.map(feature => [feature.id, `${sidebarLabel(section.title)}/${sidebarLabel(feature.title)}`])));
  return { version: 2, entries: stories.map(story => {
    const entry = { status: "unreviewed", implementation: "unreviewed", boundary: "unreviewed", notes: "", ...story.annotation, file: story.file, stableId: story.metaId, sidebarTitle: story.title };
    const prefix = navigation.get(storyHome(entry)) ?? specialHomes[storyHome(entry)];
    return { ...entry, purpose: story.title?.startsWith(`${prefix}/`) ? story.title.slice(prefix.length + 1) : story.title };
  }) };
}

export function validateCatalog(catalog, stories, index) {
  const errors = [];
  const refs = new Set(index.sections.flatMap(section => section.features.flatMap(feature => feature.capabilities.map(capability => capability.id))));
  const navigation = new Map(index.sections.flatMap(section => section.features.map(feature => [feature.id, `${sidebarLabel(section.title)}/${sidebarLabel(feature.title)}`])));
  const byFile = new Map(stories.map(story => [story.file, story]));
  for (const entry of catalog.entries) {
    const label = entry.file;
    if (!statuses.includes(entry.status)) errors.push(`${label}: invalid product status`);
    if (!implementations.includes(entry.implementation)) errors.push(`${label}: invalid implementation`);
    if (!boundaries.includes(entry.boundary)) errors.push(`${label}: invalid data boundary`);
    if (typeof entry.notes !== "string") errors.push(`${label}: notes must be text`);
    if (!Array.isArray(entry.capabilities) || entry.capabilities.some(ref => typeof ref !== "string")) { errors.push(`${label}: capabilities must be an array of IDs`); continue; }
    if (entry.home !== undefined && !["foundations", "design-proposals"].includes(entry.home)) errors.push(`${label}: only shared foundations and design proposals may override the capability home`);
    if (entry.exception !== undefined && (typeof entry.exception !== "string" || !entry.exception.trim())) errors.push(`${label}: exception must be nonempty text`);
    if (entry.home === "foundations" && !entry.exception) errors.push(`${label}: foundation home needs an explicit reason`);
    if (entry.home === "design-proposals") {
      if (entry.status !== "proposed") errors.push(`${label}: design proposal home requires proposed status`);
      if (!entry.exception) errors.push(`${label}: design proposal home needs an explicit staging reason`);
    }
    for (const ref of entry.capabilities) if (!refs.has(ref)) errors.push(`${label}: unknown feature capability ${ref}`);
    if (!entry.capabilities.length && !entry.exception) errors.push(`${label}: unmapped story needs an explicit reason`);
    if (entry.capabilities.length !== new Set(entry.capabilities).size) errors.push(`${label}: duplicate capability references`);
    const area = storyHome(entry);
    const prefix = navigation.get(area) ?? specialHomes[area];
    if (!label.startsWith(`${storyRoot}/${area}/`)) errors.push(`${label}: story must live in its primary feature folder ${area}`);
    if (!prefix || typeof entry.sidebarTitle !== "string" || !entry.sidebarTitle.startsWith(`${prefix}/`)) errors.push(`${label}: sidebar title must match its feature-map home`);
    if (typeof entry.stableId !== "string" || !entry.stableId.trim()) errors.push(`${label}: explicit meta ID is required`);
    if (entry.replacement !== undefined && !byFile.has(entry.replacement)) errors.push(`${label}: replacement story is missing`);
  }
  const metaIds = stories.map(story => story.metaId);
  const ids = [...stories.flatMap(story => story.ids), ...index.sections.flatMap(section => section.features.map(feature => `feature-map-${feature.id}--overview`))];
  if (metaIds.length !== new Set(metaIds).size || ids.length !== new Set(ids).size) errors.push("Duplicate story IDs");
  return errors;
}
function cell(value) { return String(value).replaceAll("|", "\\|").replaceAll("\n", " "); }

export function renderIndex(catalog, stories, index) {
  const byFile = new Map(stories.map(story => [story.file, story]));
  const groups = new Map();
  for (const entry of catalog.entries) {
    const home = storyHome(entry);
    const area = ["foundations", "overview"].includes(home) ? "foundations-and-guides" : home;
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(entry);
  }
  const lines = ["# Storybook by feature", "", "Generated from story annotations and feature recipes. Do not edit this file.", "",
    "[Contract and maintenance](../storybook-map/README.md) · [Verification routes](verification.md)", "",
    `${stories.length} story files; ${stories.reduce((n, story) => n + story.ids.length, 0)} indexed stories. Counts describe inventory, not passed tests or complete feature coverage.`, "",
    "Status describes product alignment; implementation describes the rendered subject; boundary describes simulated data. Limitations are authored alongside each story. Classification is not executed evidence. Related capabilities cross-list one canonical story file.", ""];
  const homes = [
    { id: "design-proposals", title: "Proposed design system", section: "Design proposals", description: "Staged design work for review. These examples retain capability references but do not count as current product coverage." },
    ...index.sections.flatMap(section => section.features.map(feature => ({ ...feature, section: section.title }))),
  ];
  homes.push({ id: "foundations-and-guides", title: "Shared foundations and guides", section: "Foundations", description: "Shared components and contributor guidance outside the product feature index." });
  let currentSection;
  for (const feature of homes) {
    const area = feature.id;
    const entries = groups.get(area) ?? [];
    if (feature.section !== currentSection) {
      lines.push(`## ${feature.section}`, "");
      currentSection = feature.section;
    }
    lines.push(`### ${feature.title}`, "", feature.description, "", ...(!["foundations-and-guides", "design-proposals"].includes(area) ? [`[Feature recipe](../feature-map/${area}.md)`, ""] : []));
    if (!entries.length) lines.push("No primary story suite. Check capability lookup below for related examples; this does not imply a missing product feature.", "");
    else lines.push(
      "| Story suite | Capabilities | Product / implementation / data | Stories / play functions | Review note |",
      "| --- | --- | --- | --- | --- |");
    for (const entry of entries.sort((a, b) => a.file.localeCompare(b.file))) {
      const story = byFile.get(entry.file);
      lines.push(`| [${cell(story.title)}](../../${entry.file}) | ${entry.capabilities.map(ref => `\`${ref}\``).join(", ") || cell(entry.exception)} | ${entry.status} / ${entry.implementation} / ${entry.boundary} | ${story.ids.length} / ${story.plays} | ${cell(entry.notes)} |`);
    }
    lines.push("");
  }
  lines.push("## Capability lookup", "", "References are navigation links, not proof of parity. An absent link means no cataloged story, not a missing product feature. CLI/operator capabilities may need no Storybook example.", "");
  for (const ref of index.sections.flatMap(section => section.features.flatMap(feature => feature.capabilities.map(capability => capability.id)))) {
    const entries = catalog.entries.filter(entry => entry.capabilities.includes(ref));
    lines.push(`- \`${ref}\`: ${entries.length ? entries.map(entry => `[${cell(byFile.get(entry.file).title)}](../../${entry.file}) (${entry.status})`).join(", ") : "No cataloged story."}`);
  }
  return lines.join("\n") + "\n";
}

export function renderVerification(catalog, index) {
  const examples = catalog.entries.filter(entry => entry.implementation !== "guide" && !["historical", "proposed"].includes(entry.status));
  const capabilities = index.sections.flatMap(section => section.features.flatMap(feature => feature.capabilities));
  const missing = capabilities.filter(capability => !examples.some(entry => entry.capabilities.includes(capability.id)));
  const lines = ["# Storybook verification routes", "", "Generated from story annotations and feature recipes. Associations are navigation, not proof of passing tests.", "",
    `${capabilities.length} capabilities; ${missing.length} without a current, mixed or unreviewed example. Historical examples, proposals and guides do not remove gaps.`, "",
    "## Capabilities without examples", ""];
  for (const capability of missing) {
    const area = capability.id.split("/")[0];
    lines.push(`- [${capability.id}](../feature-map/${area}.md): ${capability.verification?.storybook ?? "No example associated. Inspect the feature recipe to select verification."}`);
  }
  lines.push("", "## Authored verification guidance", "");
  for (const capability of capabilities.filter(capability => capability.verification)) {
    const route = capability.verification;
    lines.push(`### ${capability.id}`, "", `Scope: ${route.scope}`, "", `Storybook: ${route.storybook}`, "", `Production: ${route.production}`, "", `Sources: ${route.sources}`, "");
  }
  return lines.join("\n");
}

export function generateStorybook(root = defaultRoot, { write = true } = {}) {
  const mapErrors = checkMaps(root).errors;
  if (mapErrors.length) throw new Error(mapErrors.join("\n"));
  const index = featureIndex(root);
  const stories = scanStories(root);
  const catalog = catalogFromStories(stories, index);
  const errors = validateCatalog(catalog, stories, index);
  if (errors.length) throw new Error(errors.join("\n"));
  if (write) {
    generateFeatureArtifacts(root, index);
    writeArtifacts(root, new Map([
      [`${generatedRoot}/catalog.json`, JSON.stringify(catalog, null, 2) + "\n"],
      ["maps/generated/storybook.md", renderIndex(catalog, stories, index)],
      ["maps/generated/verification.md", renderVerification(catalog, index)],
    ]));
  }
  return { catalog, stories, index };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--write", "--check"].includes(arg)) || args.length > 1) throw new Error("Usage: node scripts/storybook-catalog.mjs [--write | --check]");
  const { stories } = generateStorybook(defaultRoot, { write: !args.includes("--check") });
  console.log(`Storybook map: ${stories.length} files, ${stories.reduce((n, story) => n + story.ids.length, 0)} stories. Structure only; no runtime proof.`);
}
