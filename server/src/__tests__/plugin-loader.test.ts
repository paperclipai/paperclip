import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pluginLoaderPath = path.resolve(import.meta.dirname, "../adapters/plugin-loader.ts");

describe("external adapter plugin loader", () => {
  it("keeps adapter loading dynamic instead of hardcoding external adapter imports", () => {
    const source = fs.readFileSync(pluginLoaderPath, "utf8");
    const importSpecifiers = Array.from(
      source.matchAll(/^\s*import(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["'];?$/gm),
      (match) => match[1],
    );

    expect(source).toContain("await import(modulePath)");
    expect(importSpecifiers.filter((specifier) => specifier.startsWith("../adapters/"))).toEqual([]);
    expect(importSpecifiers.filter((specifier) => specifier.startsWith("@paperclipai/"))).toEqual([]);
  });
});
