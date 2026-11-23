import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

describe("native select option styles", () => {
  it("paints options and option groups with the popover colors so transparent selects stay readable in dark mode", () => {
    const rule = stylesheet.match(/select option,\s*select optgroup\s*\{([^}]*)\}/);
    expect(rule, "Missing rule for select option, select optgroup").not.toBeNull();
    const block = rule![1];
    expect(block).toMatch(/background-color:\s*var\(--popover\);/);
    expect(block).toMatch(/(?<!-)color:\s*var\(--popover-foreground\);/);
  });
});
