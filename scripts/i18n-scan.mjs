import fs from "node:fs";
import path from "node:path";

const defaultRoots = ["ui/src/pages", "ui/src/components"];
const candidateExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredFileSuffixes = [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".d.ts"];
const ignoredPathSegments = [
  `${path.sep}fixtures${path.sep}`,
  `${path.sep}i18n${path.sep}`,
  `${path.sep}components${path.sep}ui${path.sep}`,
];

const propPattern = /\b(label|title|placeholder|aria-label)\s*=\s*["']([^"']*[A-Za-z][^"']*)["']/g;
const objectPattern = /\b(label|title|description|text)\s*:\s*["']([^"']*[A-Za-z][^"']*)["']/g;
const jsxTextPattern = />\s*([A-Za-z][^<>{}]*)\s*</g;

function shouldSkipFile(filePath) {
  return ignoredFileSuffixes.some((suffix) => filePath.endsWith(suffix))
    || ignoredPathSegments.some((segment) => filePath.includes(segment));
}

function walkFiles(entryPath, files = []) {
  const stats = fs.statSync(entryPath);
  if (stats.isDirectory()) {
    for (const child of fs.readdirSync(entryPath)) {
      walkFiles(path.join(entryPath, child), files);
    }
    return files;
  }

  if (candidateExtensions.has(path.extname(entryPath)) && !shouldSkipFile(entryPath)) {
    files.push(entryPath);
  }

  return files;
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function looksLikeUiText(value) {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  if (!/[A-Za-z]/.test(normalized)) return false;
  if (normalized.length < 2) return false;
  if (/^(true|false|null|undefined)$/i.test(normalized)) return false;
  if (/^[A-Z0-9_./:-]+$/.test(normalized)) return false;
  if (/^[a-z][A-Za-z0-9]+$/.test(normalized) && /[A-Z]/.test(normalized)) return false;
  if (/^[a-z0-9_.-]+$/.test(normalized) && /[_.]/.test(normalized)) return false;
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) return false;
  if (normalized.startsWith("/") || normalized.startsWith("@/")) return false;
  if (normalized.includes("import(") || normalized.includes("export ")) return false;
  if (normalized.includes("=>") || normalized.includes("|")) return false;
  if (/^(const|let|var|return|case|type|interface)\b/.test(normalized)) return false;
  if (normalized.startsWith("JSON row for this instance")) return false;
  return true;
}

function collectMatches(filePath) {
  const matches = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const seen = new Set();

  lines.forEach((line, index) => {
    const patterns = [
      [propPattern, "prop"],
      [objectPattern, "object"],
      [jsxTextPattern, "jsx"],
    ];

    for (const [pattern, kind] of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const text = normalizeText(match[2] ?? match[1] ?? "");
        if (!looksLikeUiText(text)) continue;
        const key = `${index + 1}:${kind}:${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          filePath,
          line: index + 1,
          kind,
          text,
        });
      }
    }
  });

  return matches;
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const roots = args.filter((arg) => arg !== "--strict");
const searchRoots = roots.length > 0 ? roots : defaultRoots;
const files = searchRoots
  .map((root) => path.resolve(root))
  .filter((root) => fs.existsSync(root))
  .flatMap((root) => walkFiles(root));
const matches = files.flatMap((filePath) => collectMatches(filePath));

if (matches.length === 0) {
  console.log("No potential hardcoded UI strings found.");
  console.log(`Scanned ${files.length} files.`);
  process.exit(0);
}

for (const match of matches) {
  const relativePath = path.relative(process.cwd(), match.filePath).replaceAll(path.sep, "/");
  console.log(`${relativePath}:${match.line} [${match.kind}] ${match.text}`);
}

console.log(`\nFound ${matches.length} potential hardcoded UI strings across ${files.length} files.`);
process.exit(strict ? 1 : 0);
