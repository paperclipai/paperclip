#!/usr/bin/env node
// okf-validate.mjs — check that a directory is a conformant Open Knowledge
// Format (OKF) v0.1 bundle.
//
// Spec: GoogleCloudPlatform/knowledge-catalog okf/SPEC.md (OKF v0.1).
//
// Conformance (errors):
//   1. Every non-reserved .md file contains a parseable YAML frontmatter block.
//   2. Every frontmatter block contains a non-empty `type` field.
//
// The spec requires consumers to TOLERATE (warnings, never errors):
//   - missing optional frontmatter fields, unknown types, unknown extra keys;
//   - broken cross-links (a link whose target is absent is not malformed).
//
// Usage:
//   node okf-validate.mjs <bundle-dir>
// Exits 0 when conformant, 1 when errors are found, 2 on bad invocation.
//
// Import-safe: the pure `validateOkfBundle(dir)` returns a structured report
// for unit tests; the CLI only runs when executed directly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RESERVED = new Set(["index.md", "log.md"]);

/**
 * Validate an OKF v0.1 bundle directory.
 * @param {string} dir bundle root
 * @returns {{ok: boolean, errors: string[], warnings: string[], conceptCount: number, fileCount: number}}
 */
export function validateOkfBundle(dir) {
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, errors: [`bundle directory not found: ${dir}`], warnings, conceptCount: 0, fileCount: 0 };
  }

  const mdFiles = listFiles(dir).filter((rel) => rel.endsWith(".md"));
  const present = new Set(listFiles(dir));
  let conceptCount = 0;

  for (const rel of mdFiles) {
    const base = path.posix.basename(rel);
    const text = fs.readFileSync(path.join(dir, rel), "utf8");

    if (RESERVED.has(base)) {
      if (base === "log.md") checkLog(rel, text, warnings);
      continue;
    }

    const parsed = parseFrontmatter(text);
    if (!parsed.hasFrontmatter) {
      errors.push(`${rel}: missing YAML frontmatter block (must start with '---').`);
      continue;
    }
    if (parsed.error) {
      errors.push(`${rel}: unparseable frontmatter — ${parsed.error}`);
      continue;
    }
    const type = parsed.frontmatter.type;
    if (type === undefined || String(type).trim() === "") {
      errors.push(`${rel}: frontmatter is missing a non-empty 'type' field.`);
      continue;
    }
    conceptCount += 1;
  }

  // Broken cross-links are warnings, never errors (consumers MUST tolerate them).
  for (const rel of mdFiles) {
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    for (const target of bundleLinkTargets(text)) {
      const resolved = resolveLink(rel, target);
      if (resolved !== null && !present.has(resolved)) {
        warnings.push(`${rel}: cross-link to missing target '${target}'.`);
      }
    }
  }

  // okf.yaml is optional, but if present it SHOULD declare the version.
  if (present.has("okf.yaml")) {
    const meta = fs.readFileSync(path.join(dir, "okf.yaml"), "utf8");
    if (!/okf_version\s*:/.test(meta)) {
      warnings.push("okf.yaml: missing okf_version declaration.");
    }
  } else {
    warnings.push("okf.yaml not found; bundle does not declare an OKF version.");
  }

  return { ok: errors.length === 0, errors, warnings, conceptCount, fileCount: listFiles(dir).length };
}

function checkLog(rel, text, warnings) {
  // Date headings in log files MUST use ISO 8601 YYYY-MM-DD form.
  const headingRe = /^#{1,6}\s+(.+?)\s*$/gm;
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    const heading = m[1];
    if (/\d{1,4}[/.\d-]+/.test(heading) && !/^\d{4}-\d{2}-\d{2}/.test(heading) && /^\d/.test(heading)) {
      warnings.push(`${rel}: date heading '${heading}' is not ISO 8601 (YYYY-MM-DD).`);
    }
  }
}

// ---- frontmatter parsing ----------------------------------------------------

/**
 * Minimal YAML frontmatter parser. Recognises flat `key: value` scalars and
 * block sequences (`key:` then `  - item`). Sufficient to validate presence
 * and non-emptiness of `type`; not a general YAML implementation.
 */
export function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { hasFrontmatter: false, frontmatter: {} };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { hasFrontmatter: true, frontmatter: {}, error: "frontmatter block is not closed with '---'" };
  const block = normalized.slice(4, end);
  const frontmatter = {};
  const lines = block.split("\n");
  let currentKey = null;
  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const listItem = /^\s+-\s+(.*)$/.exec(raw);
    if (listItem && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(unquote(listItem[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) {
      return { hasFrontmatter: true, frontmatter, error: `cannot parse line: ${raw.trim()}` };
    }
    currentKey = kv[1];
    const value = kv[2].trim();
    if (value === "") {
      frontmatter[currentKey] = ""; // may become a list on following lines
    } else {
      frontmatter[currentKey] = unquote(value);
    }
  }
  return { hasFrontmatter: true, frontmatter };
}

function unquote(value) {
  const s = value.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

// ---- cross-link resolution --------------------------------------------------

function bundleLinkTargets(text) {
  const targets = [];
  const re = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    targets.push(m[1]);
  }
  return targets;
}

function resolveLink(fromRel, target) {
  // Only resolve intra-bundle markdown links. Skip external/anchor links.
  const clean = target.split("#")[0];
  if (clean === "") return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return null; // has a scheme (http:, paperclip:, mailto:)
  if (!clean.endsWith(".md")) return null;
  if (clean.startsWith("/")) return clean.replace(/^\/+/, "");
  const dir = path.posix.dirname(fromRel);
  return path.posix.normalize(path.posix.join(dir, clean));
}

// ---- directory walk ---------------------------------------------------------

function listFiles(dir) {
  const out = [];
  function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  walk(dir, "");
  return out;
}

// ---- CLI --------------------------------------------------------------------

function main(argv) {
  const dir = argv[0];
  if (!dir) {
    process.stderr.write("Usage: node okf-validate.mjs <bundle-dir>\n");
    process.exit(2);
  }
  const report = validateOkfBundle(dir);
  for (const w of report.warnings) process.stdout.write(`warn: ${w}\n`);
  for (const e of report.errors) process.stdout.write(`error: ${e}\n`);
  process.stdout.write(
    `${report.ok ? "OK" : "FAIL"} — ${report.conceptCount} concept(s), ${report.fileCount} file(s), ` +
      `${report.errors.length} error(s), ${report.warnings.length} warning(s).\n`,
  );
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
