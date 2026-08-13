#!/usr/bin/env node
// okf-export.mjs — convert a Paperclip company-knowledge dump (JSON) into an
// Open Knowledge Format (OKF) v0.1 bundle: a directory of markdown files with
// YAML frontmatter, plus index.md, log.md, and bundle-root okf.yaml metadata.
//
// Spec: GoogleCloudPlatform/knowledge-catalog okf/SPEC.md (OKF v0.1).
//
// Usage:
//   node okf-export.mjs <dump.json> <out-dir>
//
// The dump is assembled by the agent from the Paperclip API. See
// references/paperclip-export-mapping.md for the exact dump schema and the API
// calls that populate it.
//
// This module is import-safe: requiring it does not run the CLI. The pure
// builder `buildOkfBundle(dump, opts)` returns an array of { path, content }
// so it can be unit-tested without touching disk.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OKF_VERSION = "0.1";

// Maps each Paperclip knowledge source to an OKF directory + concept `type`.
// `type` is the only REQUIRED frontmatter field in OKF v0.1.
const SECTIONS = [
  { key: "memories", dir: "memory", type: "memory", heading: "Agent memory" },
  { key: "skills", dir: "skills", type: "skill", heading: "Skills" },
  { key: "decisions", dir: "decisions", type: "decision", heading: "Issue decisions" },
  { key: "docs", dir: "docs", type: "document", heading: "Documents" },
  { key: "sources", dir: "sources", type: "source", heading: "Content Machine sources" },
];

/**
 * Build an OKF v0.1 bundle from a Paperclip knowledge dump.
 * @param {object} dump   Parsed knowledge dump (see paperclip-export-mapping.md).
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] ISO-8601 timestamp stamped into okf.yaml / log.md.
 * @returns {{path: string, content: string}[]} bundle files, bundle-relative paths.
 */
export function buildOkfBundle(dump, opts = {}) {
  if (!dump || typeof dump !== "object") {
    throw new Error("dump must be an object");
  }
  const generatedAt = opts.generatedAt ?? dump?.company?.exportedAt ?? "";
  const company = dump.company ?? {};
  const files = [];
  const usedNames = new Set();

  // Concept documents, grouped by section for index.md.
  const indexGroups = [];
  for (const section of SECTIONS) {
    const entries = Array.isArray(dump[section.key]) ? dump[section.key] : [];
    if (entries.length === 0) continue;
    const group = { heading: section.heading, items: [] };
    const seenSlugs = new Set();
    for (const entry of entries) {
      const slug = uniqueSlug(preferredSlug(entry, section), seenSlugs);
      const relPath = `${section.dir}/${slug}.md`;
      const concept = buildConcept(entry, section);
      files.push({ path: relPath, content: concept.content });
      group.items.push({
        link: `/${relPath}`,
        title: concept.title,
        description: concept.description,
      });
      usedNames.add(relPath);
    }
    indexGroups.push(group);
  }

  files.push({ path: "okf.yaml", content: buildOkfMeta(company, generatedAt) });
  files.push({ path: "index.md", content: buildIndex(company, indexGroups) });
  files.push({ path: "log.md", content: buildLog(generatedAt, indexGroups) });

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function buildConcept(entry, section) {
  const title = firstNonEmpty(entry.title, entry.name, entry.identifier, entry.id) || "Untitled";
  const description = oneLine(firstNonEmpty(entry.description, entry.summary, entry.outcome) || "");
  const frontmatter = {
    type: section.type,
    title,
  };
  if (description) frontmatter.description = description;
  const resource = firstNonEmpty(entry.resource, entry.url, paperclipResource(entry, section));
  if (resource) frontmatter.resource = resource;
  const tags = normalizeTags(entry.tags);
  if (tags.length) frontmatter.tags = tags;
  const timestamp = firstNonEmpty(entry.timestamp, entry.updatedAt, entry.createdAt);
  if (timestamp) frontmatter.timestamp = timestamp;

  const bodyParts = [];
  bodyParts.push(`# ${title}`);
  if (description) bodyParts.push(description);
  const body = firstNonEmpty(entry.body, entry.content);
  if (body) bodyParts.push(String(body).trim());
  // Decisions carry an explicit outcome line that is worth surfacing in-body.
  if (section.type === "decision" && entry.outcome && entry.outcome !== description) {
    bodyParts.push(`**Outcome:** ${oneLine(entry.outcome)}`);
  }
  if (Array.isArray(entry.citations) && entry.citations.length) {
    const lines = ["# Citations"];
    entry.citations.forEach((c, i) => {
      const label = typeof c === "string" ? c : firstNonEmpty(c.title, c.url, c.ref) || `Source ${i + 1}`;
      const target = typeof c === "string" ? c : firstNonEmpty(c.url, c.ref, c.path) || "";
      lines.push(target ? `${i + 1}. [${label}](${target})` : `${i + 1}. ${label}`);
    });
    bodyParts.push(lines.join("\n"));
  }

  const content = `${renderFrontmatter(frontmatter)}\n${bodyParts.join("\n\n")}\n`;
  return { content, title, description };
}

function buildOkfMeta(company, generatedAt) {
  const meta = {
    okf_version: OKF_VERSION,
    title: firstNonEmpty(company.name, "Company knowledge") + " knowledge",
    description: oneLine(
      firstNonEmpty(company.description, "Company knowledge exported from Paperclip as an OKF bundle."),
    ),
  };
  if (company.prefix) meta.source = `paperclip:company:${company.prefix}`;
  if (generatedAt) meta.generated_at = generatedAt;
  return renderYaml(meta);
}

function buildIndex(company, groups) {
  const lines = [];
  const name = firstNonEmpty(company.name, "Company") + " knowledge";
  lines.push(`# ${name}`);
  lines.push("");
  lines.push(
    "Open Knowledge Format (OKF) v" +
      OKF_VERSION +
      " bundle exported from Paperclip. Each entry below is a markdown concept document with YAML frontmatter.",
  );
  for (const group of groups) {
    lines.push("");
    lines.push(`## ${group.heading}`);
    lines.push("");
    for (const item of group.items) {
      const desc = item.description ? ` — ${item.description}` : "";
      lines.push(`- [${item.title}](${item.link})${desc}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildLog(generatedAt, groups) {
  const date = isoDate(generatedAt) || "0000-00-00";
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  const lines = ["# Log", "", `## ${date}`, "", `- Exported ${total} knowledge concept(s) from Paperclip.`];
  for (const group of groups) {
    lines.push(`  - ${group.heading}: ${group.items.length}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---- helpers ----------------------------------------------------------------

function preferredSlug(entry, section) {
  const base = firstNonEmpty(entry.name, entry.identifier, entry.slug, entry.title, entry.id);
  if (section.type === "document" && entry.issueIdentifier) {
    return slugify(`${entry.issueIdentifier}-${firstNonEmpty(entry.key, entry.title, "doc")}`);
  }
  return slugify(base || section.type);
}

function uniqueSlug(slug, seen) {
  let candidate = slug || "item";
  let n = 2;
  while (seen.has(candidate)) {
    candidate = `${slug}-${n++}`;
  }
  seen.add(candidate);
  return candidate;
}

function paperclipResource(entry, section) {
  if (section.type === "decision" && entry.identifier) return `paperclip:issue:${entry.identifier}`;
  if (section.type === "document" && entry.issueIdentifier) {
    return `paperclip:document:${entry.issueIdentifier}:${firstNonEmpty(entry.key, "doc")}`;
  }
  if (section.type === "memory" && entry.name) return `paperclip:memory:${entry.name}`;
  if (section.type === "skill" && entry.name) return `paperclip:skill:${entry.name}`;
  if (section.type === "source" && entry.id) return `paperclip:source:${entry.id}`;
  return "";
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).trim()).filter(Boolean);
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function oneLine(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isoDate(timestamp) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(timestamp || ""));
  return m ? m[1] : "";
}

// Minimal, dependency-free YAML frontmatter renderer for flat objects whose
// values are strings, numbers, booleans, or string arrays. Strings are
// double-quoted and escaped so they round-trip through any YAML parser.
function renderFrontmatter(obj) {
  return `---\n${renderYaml(obj)}---\n`;
}

function renderYaml(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${scalar(item)}`);
    } else {
      lines.push(`${key}: ${scalar(value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function scalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = oneLine(value);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---- CLI --------------------------------------------------------------------

function main(argv) {
  const [dumpPath, outDir] = argv;
  if (!dumpPath || !outDir) {
    process.stderr.write("Usage: node okf-export.mjs <dump.json> <out-dir>\n");
    process.exit(2);
  }
  const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  const files = buildOkfBundle(dump);
  for (const file of files) {
    const dest = path.join(outDir, file.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content, "utf8");
  }
  process.stdout.write(`Wrote ${files.length} files to ${outDir}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
