#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sections = [
  "Sub-features",
  "How to get to it (user POV)",
  "Driving it",
  "Gotchas",
];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  }).sort();
}

function withoutFences(text) {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
}

function entryIds(text, label, errors) {
  const headings = [...text.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
  const ids = headings.map((heading) => /^`([a-z][a-z0-9-]*)`$/.exec(heading)?.[1]);
  if (!ids.length || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    errors.push(`${label}: use unique H3 entry-point IDs, e.g. ### \`task-thread\``);
  }
  return ids.filter(Boolean);
}

export function checkFeatureMap(repoRoot = defaultRoot) {
  const errors = [];
  const mapRoot = resolve(repoRoot, "feature-map");
  const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");
  const normalize = (path) => relative(repoRoot, path).split(sep).join("/");
  const isFile = (path) => existsSync(path) && statSync(path).isFile();
  const localFile = (base, path) => {
    const target = resolve(base, path);
    const rel = relative(repoRoot, target);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && isFile(target);
  };

  const documents = readdirSync(mapRoot).filter((file) => file.endsWith(".md")).sort();
  const recipes = documents.filter((file) => file !== "README.md");
  if (!recipes.length) errors.push("feature-map: expected at least one recipe");
  const index = read("feature-map/README.md");
  const featureSection = index.split("\n## Features\n")[1]?.split("\n## ")[0] ?? "";
  const indexed = [...featureSection.matchAll(/\]\(\.\/([\w-]+\.md)\)/g)].map((m) => m[1]);
  for (const file of recipes) {
    if (indexed.filter((link) => link === file).length !== 1) {
      errors.push(`README.md: Features must link ${file} exactly once`);
    }
  }
  for (const file of indexed) {
    if (!recipes.includes(file)) errors.push(`README.md: unknown recipe ${file}`);
  }

  let entryPointCount = 0;
  for (const file of documents) {
    const raw = read(`feature-map/${file}`);
    const text = withoutFences(raw);
    // Map documents use inline Markdown links. Anchors and external links are
    // allowed; local targets must be existing files inside the checkout.
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const path = target.split("#")[0];
      if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) continue;
      if (!localFile(mapRoot, path)) errors.push(`${file}: broken local link ${target}`);
    }
    // Also validate test paths in runnable code blocks or backticked references.
    // This deliberately checks filenames, not test titles or behavioral coverage.
    const localReferences = raw.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, "");
    const testRefs = [...localReferences.matchAll(/(?<![\w-])((?:\.github|ui|server|packages|tests|cli|scripts)\/[\w./-]+\.(?:test|spec)\.(?:[cm]?[jt]sx?))\b/g)]
      .map((match) => match[1]);
    for (const path of new Set(testRefs)) {
      if (!localFile(repoRoot, path)) errors.push(`${file}: missing test ${path}`);
    }
    if (file === "README.md") continue;
    if (!/^# [^\n]+\n\s*\n\S/.test(text)) {
      errors.push(`${file}: start with an H1 and a description paragraph`);
    }
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    if (JSON.stringify(headings) !== JSON.stringify(sections)) {
      errors.push(`${file}: expected sections in order: ${sections.join(", ")}`);
      continue;
    }
    const bodies = sections.map((title) => text.split(`\n## ${title}\n`)[1]?.split("\n## ")[0] ?? "");
    if (bodies.some((body) => !body.trim())) errors.push(`${file}: sections must not be empty`);
    const subIds = [...bodies[0].matchAll(/^- `([a-z][a-z0-9-]*)`:/gm)].map((match) => match[1]);
    if (!subIds.length || new Set(subIds).size !== subIds.length) {
      errors.push(`${file}: Sub-features needs unique backticked IDs`);
    }
    const entries = entryIds(bodies[1], `${file} entry points`, errors);
    const drives = entryIds(bodies[2], `${file} driving recipes`, errors);
    entryPointCount += entries.length;
    if (JSON.stringify([...entries].sort()) !== JSON.stringify([...drives].sort())) {
      errors.push(`${file}: entry points and driving recipe IDs must match`);
    }
    if (!bodies[2].trimStart().startsWith("Preconditions:")) {
      errors.push(`${file}: Driving it must start with Preconditions:`);
    }
    for (const id of drives) {
      const recipe = bodies[2].split(`### \`${id}\`\n`)[1]?.split("\n### ")[0] ?? "";
      if (!/^Automated: \S/m.test(recipe) || !/^Manual: \S/m.test(recipe)) {
        errors.push(`${file}#${id}: describe Automated: evidence/gaps and Manual: steps`);
      }
    }
    if (!testRefs.length) errors.push(`${file}: reference at least one existing test file`);
  }

  const inventory = JSON.parse(read("feature-map/coverage.json"));
  if (inventory.version !== 1 || !Array.isArray(inventory.areas) || !inventory.areas.length) {
    errors.push("coverage.json: expected version 1 and nonempty areas");
    return { errors, recipes: recipes.length, entryPoints: entryPointCount, pages: 0 };
  }
  const pages = walk(resolve(repoRoot, "ui/src/pages"))
    .filter((path) => path.endsWith(".tsx") && !/\.(test|spec|stories)\.tsx$/.test(path))
    .map(normalize);
  if (!pages.length) errors.push("coverage.json: expected UI page modules");
  const accounted = new Set();
  const areaIds = new Set();
  for (const area of inventory.areas) {
    if (!area || typeof area !== "object") {
      errors.push("coverage.json: each area must be an object");
      continue;
    }
    const label = `coverage.json: ${area.id ?? "unnamed area"}`;
    if (typeof area.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(area.id) || areaIds.has(area.id)) {
      errors.push(`${label}: expected a unique stable area ID`);
    }
    areaIds.add(area.id);
    if (typeof area.title !== "string" || !area.title.trim()) errors.push(`${label}: title required`);
    if (!["mapped", "partial", "unmapped"].includes(area.status)) errors.push(`${label}: invalid status`);
    if (area.status !== "mapped" && (typeof area.gap !== "string" || !area.gap.trim())) {
      errors.push(`${label}: explain the remaining gap`);
    }
    if (!Array.isArray(area.features)) {
      errors.push(`${label}: features must be an array`);
    } else {
      if ((area.status === "unmapped") !== (area.features.length === 0)) {
        errors.push(`${label}: mapped/partial areas need recipes; unmapped areas must have none`);
      }
      for (const feature of area.features) {
        if (!recipes.includes(feature)) errors.push(`${label}: unknown recipe ${feature}`);
      }
    }
    if (!Array.isArray(area.paths) || !area.paths.length) {
      errors.push(`${label}: paths must be a nonempty array`);
      continue;
    }
    for (const path of area.paths) {
      if (!pages.includes(path)) errors.push(`${label}: stale or non-page path ${path}`);
      if (accounted.has(path)) errors.push(`${label}: duplicate page ${path}`);
      accounted.add(path);
    }
  }
  for (const path of pages) {
    if (!accounted.has(path)) errors.push(`coverage.json: unclassified page ${path}; map it or record a gap`);
  }
  return { errors, recipes: recipes.length, entryPoints: entryPointCount, pages: pages.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkFeatureMap();
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Feature map OK: ${result.recipes} recipes, ${result.entryPoints} entry points, ${result.pages} page modules accounted for (not live verification).`);
    }
  } catch (error) {
    console.error(`Feature map check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
