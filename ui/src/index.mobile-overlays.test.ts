import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "index.css"), "utf8");

describe("index.css mobile toolbar wrapping and bottom-nav clearance", () => {
  it("defines mobile overlay bottom clearance tokens based on the 4rem MobileBottomNav height", () => {
    expect(css).toMatch(/--mobile-nav-overlay-bottom:\s*calc\(4rem \+ var\(--spacing\) \* 3 \+ var\(--sz-safe-bottom\)\);/);
    expect(css).toMatch(/--mobile-nav-overlay-max-h:\s*calc\(100dvh - var\(--mobile-nav-overlay-bottom\) - var\(--spacing\) \* 4\);/);
  });

  it("wraps .design-toolbar-actions and expands inbox search below 48rem", () => {
    expect(css).toMatch(
      /@media\s*\(width\s*<\s*48rem\)\s*\{\s*\.design-toolbar-actions\s*\{[^}]*flex-wrap:\s*wrap;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    );
    expect(css).toMatch(
      /@media\s*\(width\s*<\s*48rem\)\s*\{\s*\[data-canonical-toolbar="inbox"\]\s*\[data-toolbar-search\]\s*\{\s*width:\s*100%;\s*\}/s,
    );
  });

  it("collapses hidden .agents-org-controls-reveal on mobile list view", () => {
    expect(css).toMatch(
      /@media\s*\(width\s*<\s*48rem\)\s*\{\s*\.agents-org-toolbar\s*\{[^}]*\}\s*\.agents-org-controls-reveal:not\(\[data-visible="true"\]\)\s*\{\s*display:\s*none;\s*\}/s,
    );
  });

  it("lifts .agent-selection-bar cleanly above the 64px MobileBottomNav below 48rem", () => {
    expect(css).toMatch(
      /@media\s*\(width\s*<\s*48rem\)\s*\{\s*\.agent-selection-bar\s*\{[^}]*--selection-bar-bottom:\s*calc\(4rem \+ var\(--spacing\) \* 3\);/s,
    );
  });

  it("lifts .agent-config-save-bar above MobileBottomNav below 48rem while preserving cascade and reduced-motion order", () => {
    const baseSettingsClearanceIndex = css.indexOf(
      ".agent-settings-with-save-bar { padding-bottom: calc(var(--agent-save-bar-clearance) + var(--spacing) * 4); }",
    );
    const mobileSaveBarIndex = css.search(
      /@media\s*\(width\s*<\s*48rem\)\s*\{\s*\.agent-config-save-bar\s*\{[^}]*bottom:\s*var\(--tc-composer-bottom\);[^}]*z-index:\s*var\(--z-20\);/s,
    );
    const mobileHiddenTransformIndex = css.indexOf(
      '.agent-config-save-bar:not([data-visible="true"]) {\n    transform: translateY(calc(100% + var(--tc-composer-bottom)));',
    );
    const mobileSettingsClearanceIndex = css.indexOf(
      "padding-bottom: calc(var(--agent-save-bar-clearance) + var(--tc-composer-visible-nav-offset));",
    );
    const reducedMotionIndex = css.indexOf(".agent-config-save-bar, .agent-file-copy-notice { transition: none; }");
    expect(baseSettingsClearanceIndex).toBeGreaterThan(-1);
    expect(mobileSaveBarIndex).toBeGreaterThan(baseSettingsClearanceIndex);
    expect(mobileHiddenTransformIndex).toBeGreaterThan(mobileSaveBarIndex);
    expect(mobileSettingsClearanceIndex).toBeGreaterThan(baseSettingsClearanceIndex);
    expect(reducedMotionIndex).toBeGreaterThan(mobileSettingsClearanceIndex);
  });
});
