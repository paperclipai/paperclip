import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type ModuleLayer = "domain" | "application" | "adapters";

export type ImportBoundaryViolation = {
  file: string;
  layer: ModuleLayer;
  specifier: string;
};

const IMPORT_SPECIFIER_PATTERN = /\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g;
const EXPORT_FROM_SPECIFIER_PATTERN = /\bexport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g;

const FORBIDDEN_SPECIFIERS_BY_LAYER: Record<ModuleLayer, RegExp[]> = {
  domain: [
    /^drizzle-orm$/,
    /^@paperclipai\/db$/,
    /(^|\/)services(\/|$)/,
    /(^|\/)routes(\/|$)/,
    /^node:child_process$/,
    /^node:fs$/,
    /^node:net$/,
  ],
  application: [
    /^drizzle-orm$/,
    /^@paperclipai\/db$/,
    /(^|\/)adapters(\/|$)/,
  ],
  adapters: [],
};

function extractImportSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [IMPORT_SPECIFIER_PATTERN, EXPORT_FROM_SPECIFIER_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sourceText)) !== null) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
}

export function checkImportBoundary(sourceText: string, layer: ModuleLayer): string[] {
  const forbidden = FORBIDDEN_SPECIFIERS_BY_LAYER[layer];
  if (forbidden.length === 0) return [];
  const specifiers = extractImportSpecifiers(sourceText);
  return specifiers.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)));
}

function layerForPath(relativePath: string): ModuleLayer | null {
  const segments = relativePath.split("/");
  if (segments.includes("domain")) return "domain";
  if (segments.includes("application")) return "application";
  if (segments.includes("adapters")) return "adapters";
  return null;
}

function listSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const info = statSync(fullPath);
      if (info.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        files.push(fullPath);
      }
    }
  };
  walk(rootDir);
  return files;
}

export function scanModuleForImportBoundaryViolations(moduleRootDir: string): ImportBoundaryViolation[] {
  const violations: ImportBoundaryViolation[] = [];
  for (const filePath of listSourceFiles(moduleRootDir)) {
    const relativePath = relative(moduleRootDir, filePath).split("\\").join("/");
    const layer = layerForPath(relativePath);
    if (!layer) continue;
    const sourceText = readFileSync(filePath, "utf8");
    for (const specifier of checkImportBoundary(sourceText, layer)) {
      violations.push({ file: relativePath, layer, specifier });
    }
  }
  return violations;
}
