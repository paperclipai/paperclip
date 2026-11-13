import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { codeBlockActionStyle } from "./MarkdownBody";

const stylesheet = readFileSync(fileURLToPath(new URL("../index.css", import.meta.url)), "utf8");

function cssBlock(selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `Missing CSS selector: ${selector}`).toBeGreaterThanOrEqual(0);

  const bodyStart = stylesheet.indexOf("{", start);
  const bodyEnd = stylesheet.indexOf("\n}", bodyStart);
  expect(bodyStart, `Missing CSS block start: ${selector}`).toBeGreaterThanOrEqual(0);
  expect(bodyEnd, `Missing CSS block end: ${selector}`).toBeGreaterThan(bodyStart);

  return stylesheet.slice(bodyStart + 1, bodyEnd);
}

/* The rendered code block used to be pinned to fixed Catppuccin literals
   in the normal AND the prose-invert variables. A code
   block therefore stayed dark in light mode. These tests fail if any of
   those surfaces is pinned to a literal again, rather than riding a token
   that carries a `.dark` override. */

describe("markdown code block styles", () => {
  it("rides theme tokens for the rendered code block surface", () => {
    const block = cssBlock(".paperclip-markdown pre");

    expect(block).toContain("background-color: var(--muted)");
    expect(block).toContain("color: var(--foreground)");
    expect(block).toContain("border: 1px solid var(--border)");
    expect(block).toContain("border-radius: var(--radius-lg)");
  });

  it("rides theme tokens for the editor content code block surface", () => {
    const block = cssBlock(".paperclip-mdxeditor-content pre");

    expect(block).toContain("background: var(--muted)");
    expect(block).toContain("color: var(--foreground)");
    expect(block).toContain("border: 1px solid var(--border)");
    expect(block).toContain("border-radius: var(--radius-lg)");
  });

  it("points the normal and inverted prose variables at the same tokens", () => {
    const block = cssBlock(".paperclip-markdown");

    expect(block).toContain("--tw-prose-pre-bg: var(--muted)");
    expect(block).toContain("--tw-prose-pre-code: var(--foreground)");
    expect(block).toContain("--tw-prose-invert-pre-bg: var(--muted)");
    expect(block).toContain("--tw-prose-invert-pre-code: var(--foreground)");
  });

  it("keeps every themed code surface free of hardcoded colors", () => {
    for (const selector of [".paperclip-markdown pre", ".paperclip-mdxeditor-content pre", ".paperclip-markdown"]) {
      // Any hex literal, or an rgb()/hsl() literal, re-pins the surface to one mode.
      expect(cssBlock(selector), `${selector} must not hardcode a color`).not.toMatch(
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i,
      );
    }
  });

  it("separates the copy and wrap controls from the code block surface", () => {
    // The controls sit on top of the block. --muted is now the block's own
    // fill, so the controls must not use it or they disappear against it.
    expect(codeBlockActionStyle.backgroundColor).toBe("var(--background)");
    expect(codeBlockActionStyle.backgroundColor).not.toContain("--muted");
  });
});
