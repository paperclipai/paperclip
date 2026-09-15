import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

/**
 * MDXEditor ships its own theme variables on its own root class, taken from its
 * LIGHT palette — `._editorRoot_… { --baseTextContrast: var(--slate-12); }` — and
 * gates the dark values behind a `.dark-theme` class we do not apply. It then
 * paints the editor body with `color: var(--baseTextContrast)`.
 *
 * Our override lands on the SAME element as that class. A bare
 * `.paperclip-mdxeditor` selector is specificity 0,1,0, identical to the
 * package's, so the winner would be decided by stylesheet order alone — and when
 * the package's sheet is later in the bundle, editor bodies (task descriptions,
 * comment composers) render near-black on the dark background.
 *
 * The `:root` prefix takes ours to 0,2,0 so it wins regardless of order. It
 * reads like redundant decoration, which is exactly why it needs a test: these
 * assertions fail if someone "cleans it up".
 */
describe("MDXEditor theme integration", () => {
  it("out-specifies the package's own root class rather than relying on stylesheet order", () => {
    // A bare `.paperclip-mdxeditor { … }` block at column zero is the
    // regression: it ties with `._editorRoot_…` instead of beating it.
    // Descendant rules (`.paperclip-mdxeditor .foo`) are already 0,2,0 and are
    // deliberately not matched here, nor is the indented block inside @media.
    expect(
      /^\.paperclip-mdxeditor\s*\{/m.test(stylesheet),
      "Theme variables must not be declared on a bare .paperclip-mdxeditor selector",
    ).toBe(false);
    expect(
      /^\.paperclip-mdxeditor-scope\s*,/m.test(stylesheet),
      "Theme variables must not be declared on a bare .paperclip-mdxeditor-scope selector",
    ).toBe(false);

    expect(stylesheet).toContain(":root .paperclip-mdxeditor-scope,\n:root .paperclip-mdxeditor {");
  });

  it("maps the package's text variables onto our own theme tokens", () => {
    const block = cssBlock(":root .paperclip-mdxeditor");

    // The one that caused the bug: the editor body reads --baseTextContrast.
    expect(block).toContain("--baseTextContrast: var(--foreground)");
    expect(block).toContain("--baseText: var(--muted-foreground)");
    expect(block).toContain("--baseTextEmphasis: var(--foreground)");
    expect(block).toContain("color: var(--foreground)");
  });
});
