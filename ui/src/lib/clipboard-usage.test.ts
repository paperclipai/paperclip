import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIRECT_CLIPBOARD_WRITE = /navigator\.clipboard|document\.execCommand/;

function sourceFiles(root: URL): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), root);
    if (entry.isDirectory()) return sourceFiles(url);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [fileURLToPath(url)];
  });
}

describe("clipboard usage", () => {
  it("routes core and first-party plugin copy actions through shared helpers", () => {
    const coreSource = new URL("../", import.meta.url);
    const pluginSource = new URL("../../../packages/plugins/plugin-workspace-diff/src/ui/", import.meta.url);
    const violations = [...sourceFiles(coreSource), ...sourceFiles(pluginSource)]
      .filter((file) => !file.replaceAll("\\", "/").endsWith("/lib/clipboard.ts"))
      .filter((file) => DIRECT_CLIPBOARD_WRITE.test(readFileSync(file, "utf8")));

    expect(violations).toEqual([]);
  });
});
