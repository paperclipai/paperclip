import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedEngine = ">=24.11.0";
const expectedTypes = "^24.0.0";
const failures = [];
const skippedDirectories = new Set([".git", ".paperclip", "coverage", "data", "dist", "node_modules"]);

function relative(filePath) {
  return path.relative(repoRoot, filePath) || ".";
}

function walk(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(entryPath, visit);
    else if (entry.isFile()) visit(entryPath);
  }
}

walk(repoRoot, (filePath) => {
  if (path.basename(filePath) !== "package.json") return;
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const specifier = manifest[section]?.["@types/node"];
    if (specifier && specifier !== expectedTypes) {
      failures.push(`${relative(filePath)}: ${section}.@types/node must be ${expectedTypes}, found ${specifier}`);
    }
  }
  if (manifest.engines?.node !== expectedEngine) {
    failures.push(`${relative(filePath)}: engines.node must be ${expectedEngine}, found ${manifest.engines?.node ?? "missing"}`);
  }
});

const workflowRoot = path.join(repoRoot, ".github", "workflows");
walk(workflowRoot, (filePath) => {
  if (!/\.ya?ml$/.test(filePath)) return;
  const source = fs.readFileSync(filePath, "utf8");
  for (const match of source.matchAll(/node-version:\s*["']?([^\s"'#]+)/g)) {
    if (match[1] !== "24") failures.push(`${relative(filePath)}: node-version must be 24, found ${match[1]}`);
  }
});

walk(repoRoot, (filePath) => {
  if (!path.basename(filePath).startsWith("Dockerfile")) return;
  const source = fs.readFileSync(filePath, "utf8");
  for (const match of source.matchAll(/^\s*FROM\s+node:([^\s]+)/gm)) {
    if (!match[1].startsWith("24-")) failures.push(`${relative(filePath)}: Node base image must use the Node 24 major, found node:${match[1]}`);
  }
  for (const match of source.matchAll(/^\s*ARG\s+NODE_(?:MAJOR|VERSION)=([^\s]+)/gm)) {
    if (match[1] !== "24") failures.push(`${relative(filePath)}: Node build argument must be 24, found ${match[1]}`);
  }
});

const requiredSourceFragments = [
  [".nvmrc", "24"],
  ["packages/shared/src/node-version.ts", 'MINIMUM_NODE_VERSION = "24.11.0"'],
  ["scripts/install.sh", "MIN_NODE_VERSION=\"${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.${MIN_NODE_PATCH}\""],
  ["scripts/install.sh", "MIN_NODE_MAJOR=24"],
  ["scripts/install.sh", "MIN_NODE_MINOR=11"],
  ["scripts/install.sh", "DEFAULT_NODE_MAJOR=24"],
  ["docker/agent-runtime/Dockerfile.base", "ARG NODE_VERSION=24"],
  ["packages/adapter-utils/src/sandbox-install-command.ts", "NODE_VERSION=\"v24.11.0\""],
  ["packages/plugins/sandbox-providers/exe-dev/src/plugin.ts", "nodesource.com/setup_24.x"],
  ["packages/plugins/sandbox-providers/modal/src/manifest.ts", 'default: "node:24"'],
  ["cli/esbuild.config.mjs", 'target: "node24"'],
  ["packages/plugins/sdk/src/bundlers.ts", 'target: "node24"'],
  ["scripts/generate-npm-package-json.mjs", `engines: { node: "${expectedEngine}" }`],
];

for (const [filePath, fragment] of requiredSourceFragments) {
  const source = fs.readFileSync(path.join(repoRoot, filePath), "utf8");
  if (!source.includes(fragment)) failures.push(`${filePath}: missing Node 24 policy fragment ${JSON.stringify(fragment)}`);
}

if (failures.length > 0) {
  console.error("Node version policy check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Node version policy check passed (Node >=24.11.0, @types/node 24.x).");
