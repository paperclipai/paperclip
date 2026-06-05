import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type RouteSharedImport = {
  importedName: string;
  routePath: string;
  typeOnly: boolean;
};

type SharedRootExports = {
  all: Set<string>;
  values: Set<string>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const routesRoot = path.join(repoRoot, "server/src/routes");
const sharedRootIndex = path.join(repoRoot, "packages/shared/src/index.ts");

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      return [entryPath];
    }
    return [];
  }));

  return files.flat();
}

async function parseSourceFile(filePath: string) {
  const sourceText = await fs.readFile(filePath, "utf8");
  return ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function collectSharedRootExports(sourceFile: ts.SourceFile): SharedRootExports {
  const all = new Set<string>();
  const values = new Set<string>();

  sourceFile.forEachChild((node) => {
    if (!ts.isExportDeclaration(node) || !node.exportClause || !ts.isNamedExports(node.exportClause)) {
      return;
    }

    for (const specifier of node.exportClause.elements) {
      const exportedName = specifier.name.text;
      all.add(exportedName);
      if (!node.isTypeOnly && !specifier.isTypeOnly) {
        values.add(exportedName);
      }
    }
  });

  return { all, values };
}

function collectRouteSharedImports(sourceFile: ts.SourceFile): RouteSharedImport[] {
  const imports: RouteSharedImport[] = [];

  sourceFile.forEachChild((node) => {
    if (
      !ts.isImportDeclaration(node)
      || !ts.isStringLiteral(node.moduleSpecifier)
      || node.moduleSpecifier.text !== "@paperclipai/shared"
      || !node.importClause
    ) {
      return;
    }

    const { importClause } = node;
    const namedBindings = importClause.namedBindings;
    expect(importClause.name, `${sourceFile.fileName} must not default import @paperclipai/shared`).toBeUndefined();
    expect(
      namedBindings && ts.isNamedImports(namedBindings),
      `${sourceFile.fileName} must use named imports from @paperclipai/shared so the startup export contract can verify them`,
    ).toBe(true);
    if (!namedBindings || !ts.isNamedImports(namedBindings)) return;

    for (const specifier of namedBindings.elements) {
      imports.push({
        importedName: specifier.propertyName?.text ?? specifier.name.text,
        routePath: path.relative(repoRoot, sourceFile.fileName),
        typeOnly: importClause.isTypeOnly || specifier.isTypeOnly,
      });
    }
  });

  return imports;
}

describe("server route shared root import contract", () => {
  it("exports every @paperclipai/shared symbol imported by server routes", async () => {
    const routeFiles = await listTypeScriptFiles(routesRoot);
    const routeImports = (await Promise.all(routeFiles.map(async (routeFile) =>
      collectRouteSharedImports(await parseSourceFile(routeFile))
    ))).flat();
    const sharedExports = collectSharedRootExports(await parseSourceFile(sharedRootIndex));

    const missingExports = routeImports
      .filter((routeImport) => {
        if (routeImport.typeOnly) return !sharedExports.all.has(routeImport.importedName);
        return !sharedExports.values.has(routeImport.importedName);
      })
      .map((routeImport) =>
        `${routeImport.routePath}: ${routeImport.importedName}${routeImport.typeOnly ? " (type)" : ""}`
      )
      .sort();

    expect(
      missingExports,
      [
        "Server routes import validators and shared contracts from the @paperclipai/shared package root.",
        "When adding a shared validator used by a route, export it from packages/shared/src/validators/index.ts",
        "and packages/shared/src/index.ts so the service fails in this smoke before a restart can fail at module startup.",
      ].join(" "),
    ).toEqual([]);
  });
});
