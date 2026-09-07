#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultServerSrc = resolve(repoRoot, "server/src");
const defaultModulesRoot = resolve(defaultServerSrc, "modules");
const layerNames = new Set(["domain", "application", "adapters"]);
const databasePackages = ["@paperclipai/db", "drizzle-orm", "embedded-postgres", "postgres"];

function normalizedRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function isPackageOrSubpath(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isDatabasePackage(specifier) {
  return databasePackages.some((packageName) => isPackageOrSubpath(specifier, packageName));
}

export function extractImportSpecifiers(sourceText) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function listProductionSourceFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (
        entry.isFile() &&
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(entryPath);
      }
    }
  };
  walk(root);
  return files.sort();
}

function moduleLocation(modulesRoot, filePath) {
  if (!isInside(modulesRoot, filePath)) return null;
  const [moduleName, layer] = normalizedRelative(modulesRoot, filePath).split("/");
  if (!moduleName) return null;
  return { moduleName, layer: layerNames.has(layer) ? layer : null };
}

function resolvedTarget(sourceFile, specifier) {
  return specifier.startsWith(".") ? resolve(dirname(sourceFile), specifier) : null;
}

function targetServerSegments(serverSrc, target) {
  if (!target || !isInside(serverSrc, target)) return [];
  return normalizedRelative(serverSrc, target).split("/");
}

function addViolation(violations, file, layer, specifier, reason) {
  violations.push({ file, layer, specifier, reason });
}

export function scanModuleBoundaries({
  serverSrc = defaultServerSrc,
  modulesRoot = defaultModulesRoot,
} = {}) {
  const violations = [];

  for (const sourceFile of listProductionSourceFiles(serverSrc)) {
    const sourceLocation = moduleLocation(modulesRoot, sourceFile);
    const sourceLabel = normalizedRelative(repoRoot, sourceFile);
    const sourceText = readFileSync(sourceFile, "utf8");

    for (const specifier of extractImportSpecifiers(sourceText)) {
      const target = resolvedTarget(sourceFile, specifier);
      const targetSegments = targetServerSegments(serverSrc, target);
      const targetLocation = target ? moduleLocation(modulesRoot, target) : null;

      if (sourceLocation?.layer === "domain") {
        if (isDatabasePackage(specifier)) {
          addViolation(violations, sourceLabel, "domain", specifier, "domain cannot import database packages");
        } else if (specifier.startsWith("node:")) {
          addViolation(violations, sourceLabel, "domain", specifier, "domain cannot import Node.js runtime modules");
        } else if (targetSegments.includes("services") || targetSegments.includes("routes")) {
          addViolation(violations, sourceLabel, "domain", specifier, "domain cannot import server services or routes");
        } else if (targetLocation?.layer === "application" || targetLocation?.layer === "adapters") {
          addViolation(violations, sourceLabel, "domain", specifier, "domain cannot depend on outer module layers");
        }
      }

      if (sourceLocation?.layer === "application") {
        if (isDatabasePackage(specifier)) {
          addViolation(violations, sourceLabel, "application", specifier, "application cannot import database packages");
        } else if (targetLocation?.layer === "adapters") {
          addViolation(violations, sourceLabel, "application", specifier, "application cannot import concrete adapters");
        } else if (targetSegments.join("/") === "errors.js" || targetSegments.join("/") === "errors.ts") {
          addViolation(violations, sourceLabel, "application", specifier, "application cannot import HTTP error helpers");
        }
      }

      if (targetLocation && sourceLocation?.moduleName !== targetLocation.moduleName) {
        const targetRelative = normalizedRelative(resolve(modulesRoot, targetLocation.moduleName), target);
        if (targetRelative !== "index.js" && targetRelative !== "index.ts") {
          addViolation(
            violations,
            sourceLabel,
            sourceLocation?.layer ?? null,
            specifier,
            `imports inside module ${targetLocation.moduleName} instead of its index`,
          );
        }
      }
    }
  }

  return violations;
}

export function formatViolation(violation) {
  const layer = violation.layer ? ` (${violation.layer})` : "";
  return `${violation.file}${layer}: ${violation.reason}: ${JSON.stringify(violation.specifier)}`;
}

function main() {
  const violations = scanModuleBoundaries();
  if (violations.length > 0) {
    console.error("Feature module boundary check failed:");
    for (const violation of violations) console.error(`- ${formatViolation(violation)}`);
    process.exitCode = 1;
    return;
  }
  console.log("Feature module boundary check passed.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
