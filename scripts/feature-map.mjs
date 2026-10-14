import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const sidebarLabel = title => title.replaceAll("/", ", ");

export function featureIndex(root) {
  const directory = path.join(root, "maps/feature-map");
  const sections = new Map();
  for (const file of readdirSync(directory).filter(file => file.endsWith(".md") && file !== "README.md").sort()) {
    const id = file.slice(0, -3);
    const source = readFileSync(path.join(directory, file), "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    const navigationLine = frontmatter?.[1].match(/^navigation: (.+)$/m)?.[1];
    if (!navigationLine) throw new Error(`${file}: missing navigation metadata`);
    const navigation = JSON.parse(navigationLine);
    if (typeof navigation.section !== "string" || !navigation.section.trim()
      || !Number.isFinite(navigation.sectionOrder) || !Number.isFinite(navigation.order)) {
      throw new Error(`${file}: invalid navigation metadata`);
    }
    const text = source.slice(frontmatter[0].length);
    const title = text.match(/^# (.+)$/m)?.[1];
    const description = text.split(/^# .+\r?\n/m)[1]?.trim().split(/\r?\n\s*\r?\n/)[0].replaceAll(/\r?\n/g, " ");
    if (!title || !description) throw new Error(`${file}: missing title or description`);
    const body = text.split(/^## Sub-features\s*$/m)[1]?.split(/^## /m)[0];
    if (!body) throw new Error(`${file}: missing sub-features`);
    const capabilities = [];
    for (const row of body.trim().split(/\r?\n/)) {
      const match = row.match(/^- `([^`]+)`:\s*(.*)$/);
      if (match) {
        const [, key, description] = match;
        capabilities.push({ id: `${id}/${key}`, label: key.replaceAll("-", " ").replace(/^./, letter => letter.toUpperCase()), description });
      } else if (row.trim() && capabilities.length) capabilities.at(-1).description += ` ${row.trim()}`;
    }
    if (!capabilities.length || capabilities.some(capability => !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(capability.id))
      || new Set(capabilities.map(capability => capability.id)).size !== capabilities.length) {
      throw new Error(`${file}: invalid or duplicate capability IDs`);
    }
    const verification = text.split(/^### Storybook verification\s*$/m)[1]?.split(/^### /m)[0] ?? "";
    const seen = new Set();
    for (const entry of verification.split(/^#### /m).slice(1)) {
      const key = entry.match(/^`([^`]+)`/)?.[1];
      const capability = capabilities.find(capability => capability.id === `${id}/${key}`);
      if (!capability || seen.has(key)) throw new Error(`${file}: unknown or duplicate verification capability ${key}`);
      seen.add(key);
      const fields = Object.fromEntries(["Scope", "Storybook", "Production", "Sources"].map(field => [field.toLowerCase(), entry.match(new RegExp(`^${field}: (.+)$`, "m"))?.[1]]));
      if (!["ui", "cli", "browser"].includes(fields.scope) || Object.values(fields).some(value => !value?.trim())) {
        throw new Error(`${file}: incomplete verification route for ${key}`);
      }
      capability.verification = fields;
    }
    let section = sections.get(navigation.section);
    if (!section) {
      section = { title: navigation.section, order: navigation.sectionOrder, features: [] };
      sections.set(section.title, section);
    }
    if (section.order !== navigation.sectionOrder) throw new Error(`${file}: inconsistent section order for ${section.title}`);
    section.features.push({ id, title, description, capabilities, order: navigation.order });
  }
  if (!sections.size) throw new Error("Feature map has no feature families");
  const ordered = [...sections.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  return { sections: ordered.map(({ title, features }) => ({ title, features: features.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(({ order, ...feature }) => feature) })) };
}

export function mapIndexes(index) {
  const features = ["# Product features", "", "Generated from the feature recipes. Edit the affected recipe, not this index.", ""];
  const access = ["# Agent access by feature", "", "Generated from the feature recipes and their access companions. Counts are documentation scope, not passing tests.", ""];
  for (const section of index.sections) {
    for (const lines of [features, access]) lines.push(`## ${section.title}`, "");
    for (const feature of section.features) {
      features.push(`- [${feature.title}](../feature-map/${feature.id}.md): ${feature.description}`);
      access.push(`- [${feature.title}](../agent-access-map/${feature.id}.md) · [Product recipe](../feature-map/${feature.id}.md) · ${feature.capabilities.length} capabilities`);
    }
    for (const lines of [features, access]) lines.push("");
  }
  return new Map([["maps/generated/feature-map.md", features.join("\n")], ["maps/generated/agent-access-map.md", access.join("\n")]]);
}

export function pageInventory(root, index) {
  const references = new Map();
  for (const feature of index.sections.flatMap(section => section.features)) {
    const recipe = `maps/feature-map/${feature.id}.md`;
    for (const match of readFileSync(path.join(root, recipe), "utf8").matchAll(/\]\(([^)\n]+)\)/g)) {
      const target = path.resolve(root, path.dirname(recipe), match[1].split("#")[0]);
      if (!references.has(target)) references.set(target, new Set());
      references.get(target).add(feature.id);
    }
  }
  function pages(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return pages(file);
      if (!entry.name.endsWith(".tsx") || /\.(test|spec|stories)\.tsx$/.test(entry.name)) return [];
      return [{ file: path.relative(root, file).split(path.sep).join("/"), features: [...(references.get(file) ?? [])].sort() }];
    });
  }
  return { pages: pages(path.join(root, "ui/src/pages")).sort((a, b) => a.file.localeCompare(b.file)) };
}
