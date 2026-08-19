import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
  resolve(packageRoot, "devtools/browser/src"),
  resolve(packageRoot, "src/react"),
  resolve(packageRoot, "examples"),
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat();
}

const componentRules = [
  ["hex color", /#[0-9a-f]{3,8}\b/i],
  ["raw pixel value", /\b\d+(?:\.\d+)?px\b/],
  ["inline style", /\bstyle\s*=\s*\{/],
  ["raw font size", /\bfont(?:-size|Size)\s*[:=]/],
  ["arbitrary Tailwind value", /\b[a-z-]+-\[[^\]]+\]/],
];
const violations = [];

for (const path of (await Promise.all(sourceRoots.map(sourceFiles))).flat()) {
  if (![".ts", ".tsx"].includes(extname(path))) {
    continue;
  }
  const source = await readFile(path, "utf8");
  for (const [label, pattern] of componentRules) {
    if (pattern.test(source)) {
      violations.push(`${path.slice(packageRoot.length + 1)}: ${label}`);
    }
  }
}

for (const path of await sourceFiles(resolve(packageRoot, "src/react"))) {
  if (![".ts", ".tsx"].includes(extname(path))) continue;
  if (/\bui-[a-z-]+/.test(await readFile(path, "utf8"))) {
    violations.push(`${path.slice(packageRoot.length + 1)}: legacy ui- class name`);
  }
}

const styles = await readFile(resolve(packageRoot, "devtools/browser/src/styles.css"), "utf8");
for (const token of [
  "--background",
  "--foreground",
  "--card",
  "--primary",
  "--muted",
  "--border",
  "--ring",
  "--font-sans",
  "--font-mono",
  "--space-1",
  "--radius-sm",
  "--motion-fast",
]) {
  if (!styles.includes(`${token}:`)) {
    violations.push(`devtools/browser/src/styles.css: missing ${token}`);
  }
}

const sdkStyles = await readFile(resolve(packageRoot, "styles.css"), "utf8");
for (const token of [
  "--pcr-background",
  "--pcr-foreground",
  "--pcr-card",
  "--pcr-primary",
  "--pcr-muted",
  "--pcr-border",
  "--pcr-ring",
  "--pcr-font-sans",
  "--pcr-font-mono",
  "--pcr-space-1",
  "--pcr-radius-sm",
  "--pcr-motion-fast",
  "--pcr-touch-target",
]) {
  if (!sdkStyles.includes(`${token}:`)) {
    violations.push(`styles.css: missing ${token}`);
  }
}
if (!sdkStyles.startsWith(".pcr-root {")) {
  violations.push("styles.css: token sheet must be scoped to .pcr-root");
}
if (sdkStyles.includes(":root")) {
  violations.push("styles.css: SDK tokens may not leak onto :root");
}
if (sdkStyles.includes("\\n")) {
  violations.push("styles.css: contains a literal \\n escape sequence");
}
if (/--pcr---|\.pcr-[a-z-]+--pcr-/i.test(sdkStyles)) {
  violations.push("styles.css: malformed repeated pcr prefix");
}
const sdkTokenNames = new Set([
  ...[...sdkStyles.matchAll(/--([a-z][a-z0-9-]*)\s*:/gi)].map((match) => match[1]),
  ...[...sdkStyles.matchAll(/var\(\s*--([a-z][a-z0-9-]*)/gi)].map(
    (match) => match[1],
  ),
]);
for (const tokenName of sdkTokenNames) {
  if (!tokenName.startsWith("pcr-")) {
    violations.push(`styles.css: unprefixed SDK token --${tokenName}`);
  }
}
const cssWithoutComments = sdkStyles.replaceAll(/\/\*[\s\S]*?\*\//g, "");
const openBraces = [...cssWithoutComments].filter((character) => character === "{").length;
const closeBraces = [...cssWithoutComments].filter((character) => character === "}").length;
if (openBraces !== closeBraces) {
  violations.push(
    `styles.css: unbalanced braces (${openBraces} open, ${closeBraces} close)`,
  );
}

if (violations.length > 0) {
  process.stderr.write(`Standalone browser token check failed:\n- ${violations.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Standalone browser token check passed; component visual values stay in styles.css.\n",
  );
}
