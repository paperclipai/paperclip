import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const storybookRoot = fileURLToPath(new URL("../../ui/storybook/", import.meta.url));

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".js", ".jsx", ".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

test("Storybook viewport config uses the Storybook 10 parameter shape", () => {
  const legacyViewportKeys = [];

  for (const path of sourceFiles(storybookRoot)) {
    const source = readFileSync(path, "utf8");
    if (/\b(?:defaultViewport|viewports)\s*:/.test(source)) legacyViewportKeys.push(path);
  }

  assert.deepEqual(
    legacyViewportKeys,
    [],
    "Storybook 10 uses globals.viewport.value for selection and parameters.viewport.options for definitions",
  );
});
