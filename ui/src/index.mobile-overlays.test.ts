import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "index.css"), "utf8");

function readCustomProperty(source: string, name: string): string | null {
  const match = source.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

function readMediaBlocks(source: string, condition: string): Array<{ start: number; body: string }> {
  const blocks: Array<{ start: number; body: string }> = [];
  const pattern = new RegExp(`@media\\s*\\(\\s*${condition}\\s*\\)\\s*\\{`, "g");
  for (const match of source.matchAll(pattern)) {
    const openIndex = match.index + match[0].length;
    let depth = 1;
    let cursor = openIndex;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    blocks.push({ start: match.index, body: source.slice(openIndex, cursor - 1) });
  }
  return blocks;
}

describe("index.css mobile toolbar wrapping and bottom-nav clearance", () => {
  it("composes mobile nav offsets from a single --mobile-nav-height token", () => {
    expect(readCustomProperty(css, "--mobile-nav-height")).toBe("4rem");
    expect(readCustomProperty(css, "--tc-composer-visible-nav-offset")).toBe(
      "calc(var(--mobile-nav-height) + var(--spacing) * 1.5 + var(--sz-safe-bottom))",
    );
    expect(readCustomProperty(css, "--mobile-nav-overlay-bottom")).toBe(
      "calc(var(--mobile-nav-height) + var(--spacing) * 3 + var(--sz-safe-bottom))",
    );
    expect(readCustomProperty(css, "--mobile-nav-overlay-max-h")).toBe(
      "calc(100dvh - var(--mobile-nav-overlay-bottom) - var(--spacing) * 4)",
    );
  });

  it("wraps .design-toolbar-actions and expands inbox search below 48rem", () => {
    const mobileBlocks = readMediaBlocks(css, "width\\s*<\\s*48rem");
    const combined = mobileBlocks.map((block) => block.body).join("\n");
    expect(combined).toMatch(/\.design-toolbar-actions\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(combined).toMatch(/\[data-canonical-toolbar="inbox"\]\s*\[data-toolbar-search\]\s*\{[^}]*width:\s*100%;/s);
  });

  it("collapses hidden .agents-org-controls-reveal on mobile list view", () => {
    const mobileBlocks = readMediaBlocks(css, "width\\s*<\\s*48rem");
    const combined = mobileBlocks.map((block) => block.body).join("\n");
    expect(combined).toMatch(/\.agents-org-controls-reveal:not\(\[data-visible="true"\]\)\s*\{[^}]*display:\s*none;/s);
  });

  it("lifts .agent-selection-bar cleanly above MobileBottomNav below 48rem", () => {
    const mobileBlocks = readMediaBlocks(css, "width\\s*<\\s*48rem");
    const combined = mobileBlocks.map((block) => block.body).join("\n");
    expect(combined).toMatch(
      /\.agent-selection-bar\s*\{[^}]*--selection-bar-bottom:\s*calc\(var\(--mobile-nav-height\) \+ var\(--spacing\) \* 3\);/s,
    );
  });

  it("lifts .agent-config-save-bar above MobileBottomNav below 48rem while preserving cascade and reduced-motion order", () => {
    const baseSettingsMatch = css.match(/\.agent-settings-with-save-bar\s*\{[^}]*padding-bottom:\s*calc\(var\(--agent-save-bar-clearance\) \+ var\(--spacing\) \* 4\);[^}]*\}/);
    const mobileSaveBlock = readMediaBlocks(css, "width\\s*<\\s*48rem").find((block) =>
      block.body.includes(".agent-config-save-bar"),
    );
    const reducedMotionBlock = readMediaBlocks(css, "prefers-reduced-motion:\\s*reduce").find((block) =>
      block.body.includes(".agent-config-save-bar"),
    );

    expect(baseSettingsMatch).not.toBeNull();
    expect(mobileSaveBlock).toBeDefined();
    expect(reducedMotionBlock).toBeDefined();
    expect(mobileSaveBlock!.start).toBeGreaterThan(baseSettingsMatch!.index!);
    expect(reducedMotionBlock!.start).toBeGreaterThan(mobileSaveBlock!.start);
    expect(mobileSaveBlock!.body).toMatch(/\.agent-config-save-bar\s*\{[^}]*bottom:\s*var\(--tc-composer-bottom\);[^}]*z-index:\s*var\(--z-20\);/s);
    expect(mobileSaveBlock!.body).toMatch(/\.agent-config-save-bar:not\(\[data-visible="true"\]\)\s*\{[^}]*transform:\s*translateY\(calc\(100% \+ var\(--tc-composer-bottom\)\)\);/s);
    expect(mobileSaveBlock!.body).toMatch(/\.agent-settings-with-save-bar\s*\{[^}]*padding-bottom:\s*calc\(var\(--agent-save-bar-clearance\) \+ var\(--tc-composer-visible-nav-offset\)\);/s);
  });
});
