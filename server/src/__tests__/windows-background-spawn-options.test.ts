import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function spawnWindowsHideOptions(relativePath: string): boolean[] {
  const sourcePath = path.join(repoRoot, relativePath);
  const source = ts.createSourceFile(
    sourcePath,
    fs.readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const results: boolean[] = [];

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "spawn"
    ) {
      const options = node.arguments[2];
      const windowsHide = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) =>
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "windowsHide"
        )
        : undefined;
      results.push(
        Boolean(
          windowsHide &&
          ts.isPropertyAssignment(windowsHide) &&
          windowsHide.initializer.kind === ts.SyntaxKind.TrueKeyword,
        ),
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return results;
}

describe("Windows background process spawn options", () => {
  it.each([
    ["packages/adapter-utils/src/server-utils.ts", 1],
    ["server/src/routes/board-chat.ts", 1],
    ["server/src/services/workspace-runtime.ts", 2],
  ])("hides every console-capable spawn in %s", (relativePath, expectedSpawnCount) => {
    const options = spawnWindowsHideOptions(relativePath);

    expect(options).toHaveLength(expectedSpawnCount);
    expect(options).not.toContain(false);
  });
});
