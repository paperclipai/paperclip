import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function backgroundChildWindowsHideOptions(relativePath: string): boolean[] {
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
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === "spawn" || node.expression.text === "fork")
    ) {
      const optionsIndex = node.expression.text === "fork" ? 2 : 2;
      const optionsArgument = node.arguments[optionsIndex];
      const options = optionsArgument && ts.isAsExpression(optionsArgument)
        ? optionsArgument.expression
        : optionsArgument;
      const windowsHide = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) =>
          ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name)
          && property.name.text === "windowsHide"
        )
        : undefined;
      results.push(Boolean(
        windowsHide
        && ts.isPropertyAssignment(windowsHide)
        && windowsHide.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ));
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
    ["server/src/services/tool-gateway.ts", 1],
    ["server/src/services/plugin-worker-manager.ts", 1],
  ])("hides every enumerated background child in %s", (relativePath, expectedChildCount) => {
    const options = backgroundChildWindowsHideOptions(relativePath);
    expect(options).toHaveLength(expectedChildCount);
    expect(options).not.toContain(false);
  });
});
