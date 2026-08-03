import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface BackgroundChildOptions {
  detached: boolean;
  windowsHide: boolean;
}

function backgroundChildOptions(relativePath: string): BackgroundChildOptions[] {
  const sourcePath = path.join(repoRoot, relativePath);
  const source = ts.createSourceFile(
    sourcePath,
    fs.readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const results: BackgroundChildOptions[] = [];

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
      const detached = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) =>
          ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name)
          && property.name.text === "detached"
        )
        : undefined;
      results.push({
        detached: Boolean(
          detached
          && ts.isPropertyAssignment(detached)
          && detached.initializer.kind === ts.SyntaxKind.TrueKeyword,
        ),
        windowsHide: Boolean(
          windowsHide
          && ts.isPropertyAssignment(windowsHide)
          && windowsHide.initializer.kind === ts.SyntaxKind.TrueKeyword,
        ),
      });
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
    const options = backgroundChildOptions(relativePath);
    expect(options).toHaveLength(expectedChildCount);
    expect(options.map((entry) => entry.windowsHide)).not.toContain(false);
  });

  it("isolates adapter children from Windows console-control broadcasts", () => {
    expect(backgroundChildOptions("packages/adapter-utils/src/server-utils.ts")).toEqual([
      { detached: true, windowsHide: true },
    ]);
  });

  it("isolates the embedded Windows postmaster from launcher console-control broadcasts", () => {
    const patch = fs.readFileSync(
      path.join(repoRoot, "patches/embedded-postgres@18.1.0-beta.16.patch"),
      "utf8",
    );
    expect(patch).toContain(
      "detached: globalThis.process.platform === 'win32', windowsHide: true",
    );
  });
});
