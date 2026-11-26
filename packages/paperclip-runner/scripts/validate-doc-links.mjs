import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { wrapperMarkupIn } from "./lib/doc-wrappers.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documentationRoots = [
  resolve(packageRoot, "README.md"),
  resolve(packageRoot, "docs"),
];

async function collectMarkdown(target) {
  if (extname(target) === ".md") {
    return [target];
  }
  const files = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const path = resolve(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdown(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

function withoutFencedCode(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function linksIn(markdown) {
  const links = [];
  const pattern = /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (let match = pattern.exec(withoutFencedCode(markdown)); match; match = pattern.exec(withoutFencedCode(markdown))) {
    links.push(match[1]);
  }
  return links;
}

function githubSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function anchorsIn(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of withoutFencedCode(markdown).split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (!match) {
      continue;
    }
    const base = githubSlug(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const errors = [];
const markdownFiles = (
  await Promise.all(documentationRoots.map((root) => collectMarkdown(root)))
).flat();

for (const file of markdownFiles.sort()) {
  const markdown = await readFile(file, "utf8");
  for (const { line, tag } of wrapperMarkupIn(markdown)) {
    errors.push(`${relative(packageRoot, file)}:${line} -> leaked generation-wrapper markup ${tag}`);
  }
  for (const rawLink of linksIn(markdown)) {
    if (/^(?:https?:|mailto:|skill:)/.test(rawLink)) {
      continue;
    }
    const [rawPath, fragment] = rawLink.split("#", 2);
    let target = rawPath.length === 0 ? file : resolve(dirname(file), decodeURIComponent(rawPath));
    if (await exists(resolve(target, "index.md"))) {
      target = resolve(target, "index.md");
    }
    if (!(await exists(target))) {
      errors.push(`${relative(packageRoot, file)} -> ${rawLink} (missing target)`);
      continue;
    }
    if (fragment && target.endsWith(".md")) {
      const targetMarkdown = await readFile(target, "utf8");
      if (!anchorsIn(targetMarkdown).has(decodeURIComponent(fragment))) {
        errors.push(`${relative(packageRoot, file)} -> ${rawLink} (missing heading)`);
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`Documentation link validation failed:\n- ${errors.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Documentation link validation passed (${markdownFiles.length} files).\n`);
}
