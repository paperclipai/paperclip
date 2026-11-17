import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const folder = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.dirname(folder);

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function importSpecifiers(source: string): string[] {
  const patterns = [/\bfrom\s+["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s+["']([^"']+)["']/gm];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]!));
}

const builtins = new Set(builtinModules);
const isBuiltin = (specifier: string) => specifier.startsWith("node:") || builtins.has(specifier);
const isTestSupport = (file: string) => file.endsWith(".test.ts") || file.split(path.sep).includes("fixtures");

function disallowedImports(file: string): string[] {
  return importSpecifiers(readFileSync(file, "utf8")).filter((specifier) => {
    if (specifier.startsWith(".")) {
      const target = path.resolve(path.dirname(file), specifier);
      return !(target === folder || target.startsWith(`${folder}${path.sep}`));
    }
    if (isBuiltin(specifier)) return false;
    if (specifier === "@modelcontextprotocol/sdk" || specifier.startsWith("@modelcontextprotocol/sdk/")) return false;
    if (specifier === "zod") return false;
    if (isTestSupport(file) && (specifier === "vitest" || specifier === "@paperclipai/shared")) return false;
    return true;
  });
}

describe("google-workspace-rest-tools boundary", () => {
  it("imports only its own files, Node built-ins, the MCP SDK and zod", () => {
    const violations = typescriptFiles(folder)
      .map((file) => ({ file: path.relative(folder, file), imports: disallowedImports(file) }))
      .filter((entry) => entry.imports.length > 0);
    expect(violations).toEqual([]);
  });

  it("is not imported by any other server code yet", () => {
    const importers = typescriptFiles(serverSrc)
      .filter((file) => !file.startsWith(`${folder}${path.sep}`))
      .filter((file) => importSpecifiers(readFileSync(file, "utf8")).some((specifier) => specifier.includes("google-workspace-rest-tools")))
      .map((file) => path.relative(serverSrc, file));
    expect(importers).toEqual([]);
  });
});
