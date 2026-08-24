import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = resolve(packageRoot, "knowledge");
const RESERVED_NAMES = new Set(["index.md", "log.md"]);

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---\n")) {
    return null;
  }
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("frontmatter is missing its closing delimiter");
  }
  const values = new Map();
  for (const line of markdown.slice(4, end).split("\n")) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (match) {
      values.set(match[1], match[2].trim().replace(/^['"]|['"]$/g, ""));
    }
  }
  return values;
}

function localLinks(markdown) {
  const links = [];
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  const pattern = /(?<!!)\[[^\]]+\]\(([^)\s]+)\)/g;
  for (let match = pattern.exec(withoutCode); match; match = pattern.exec(withoutCode)) {
    if (!/^(?:https?:|mailto:)/.test(match[1]) && !match[1].startsWith("#")) {
      links.push(match[1].split("#", 1)[0]);
    }
  }
  return links;
}

function isIsoInstant(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value);
}

function validateGenerated(value) {
  const match = value.match(/^\{\s*by:\s*([^,]+),\s*at:\s*([^}]+)\s*\}$/);
  if (!match) {
    return false;
  }
  const actor = match[1].trim();
  const at = match[2].trim().replace(/^['"]|['"]$/g, "");
  return /^(?:[^\s/]+\/[^\s/]+|human:[^\s]+|process:[^\s]+)$/.test(actor) && isIsoInstant(at);
}

async function directIndexTargets(directory, markdown) {
  const targets = new Set();
  for (const rawLink of localLinks(markdown)) {
    const target = resolve(directory, rawLink);
    targets.add(target.endsWith("/") ? target.slice(0, -1) : target);
    targets.add(target.replace(/\/index\.md$/, ""));
  }
  return targets;
}

const files = await markdownFiles(bundleRoot);
const errors = [];

for (const file of files.sort()) {
  const markdown = await readFile(file, "utf8");
  const name = file.slice(file.lastIndexOf("/") + 1);
  let frontmatter;
  try {
    frontmatter = parseFrontmatter(markdown);
  } catch (error) {
    errors.push(`${relative(bundleRoot, file)}: ${error.message}`);
    continue;
  }

  if (name === "index.md") {
    if (file === resolve(bundleRoot, "index.md")) {
      if (frontmatter?.get("okf_version") !== "0.2") {
        errors.push("index.md: root index must declare okf_version: \"0.2\"");
      }
    } else if (frontmatter !== null) {
      errors.push(`${relative(bundleRoot, file)}: nested index files must not have frontmatter`);
    }
    continue;
  }

  if (name === "log.md") {
    if (frontmatter !== null) {
      errors.push(`${relative(bundleRoot, file)}: log files must not have frontmatter`);
    }
    for (const heading of markdown.matchAll(/^##\s+(.+)$/gm)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(heading[1])) {
        errors.push(`${relative(bundleRoot, file)}: log date must use YYYY-MM-DD`);
      }
    }
    continue;
  }

  if (frontmatter === null) {
    errors.push(`${relative(bundleRoot, file)}: concept document requires frontmatter`);
    continue;
  }
  if (!frontmatter.get("type")) {
    errors.push(`${relative(bundleRoot, file)}: type is required by OKF v0.2`);
  }
  if (!frontmatter.get("title") || !frontmatter.get("description")) {
    errors.push(`${relative(bundleRoot, file)}: title and description are required locally`);
  }
  if (!validateGenerated(frontmatter.get("generated") ?? "")) {
    errors.push(`${relative(bundleRoot, file)}: generated must contain a valid actor and UTC instant`);
  }
  if (!["draft", "stable", "deprecated"].includes(frontmatter.get("status") ?? "stable")) {
    errors.push(`${relative(bundleRoot, file)}: status is not an OKF v0.2 lifecycle value`);
  }

  if (frontmatter.get("type") === "Engineering Journal Entry") {
    if (!frontmatter.get("phase") || !frontmatter.get("entry_kind")) {
      errors.push(`${relative(bundleRoot, file)}: journal entries require phase and entry_kind`);
    }
  }
}

const indexedDirectories = new Set(files.filter((file) => file.endsWith("/index.md")).map(dirname));
for (const directory of [...indexedDirectories].sort()) {
  const indexPath = resolve(directory, "index.md");
  const indexMarkdown = await readFile(indexPath, "utf8");
  const targets = await directIndexTargets(directory, indexMarkdown);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md") && !RESERVED_NAMES.has(entry.name)) {
      const expected = resolve(directory, entry.name);
      if (!targets.has(expected)) {
        errors.push(`${relative(bundleRoot, indexPath)}: missing ${entry.name}`);
      }
    }
    if (entry.isDirectory()) {
      const childFiles = files.filter((file) => file.startsWith(`${resolve(directory, entry.name)}/`));
      if (childFiles.length > 0 && !targets.has(resolve(directory, entry.name))) {
        errors.push(`${relative(bundleRoot, indexPath)}: missing ${entry.name}/`);
      }
    }
  }
}

for (const file of files) {
  const directory = dirname(file);
  if (!indexedDirectories.has(directory)) {
    errors.push(`${relative(bundleRoot, file)}: containing directory requires index.md`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`OKF validation failed:\n- ${errors.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  const concepts = files.filter((file) => !RESERVED_NAMES.has(file.slice(file.lastIndexOf("/") + 1))).length;
  process.stdout.write(`OKF v0.2 validation passed (${concepts} concepts, ${indexedDirectories.size} indexes).\n`);
}
