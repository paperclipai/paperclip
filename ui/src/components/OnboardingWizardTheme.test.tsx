// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The onboarding wizard's decorative right-hand panel (which renders the
// ASCII paperclip illustration) must follow the active shadcn theme instead of
// hardcoding a dark surface. Otherwise a light/cream deployer theme (set via
// the PAPERCLIP_DEFAULT_THEME bootstrap) renders a jarring cream form next to a
// solid dark panel. The illustration glyphs already use `text-muted-foreground`,
// so the panel must sit on the paired `bg-muted` surface to read as an
// intentional ink-on-surface texture in every theme.
//
// Asserting against the source keeps this guard cheap: the panel className is a
// static string literal, and the full wizard dialog is too heavy to mount here.
const here = path.dirname(fileURLToPath(import.meta.url));

describe("OnboardingWizard decorative panel theming", () => {
  const source = readFileSync(
    path.join(here, "OnboardingWizard.tsx"),
    "utf8"
  );

  it("does not hardcode a dark decorative panel background", () => {
    expect(source).not.toContain("bg-[#1d1d1d]");
    expect(source).not.toMatch(/bg-\[#[0-9a-fA-F]{3,8}\]/);
  });

  it("themes the decorative panel with shadcn surface tokens", () => {
    // Anchor to the wrapper around <AsciiArtAnimation /> so the guard checks
    // the decorative panel itself (the same tokens appear elsewhere in the
    // wizard), then assert each token independently so a class reorder or a
    // utility inserted between them cannot false-fail the test. `[^<>]`
    // keeps the match from spanning across other JSX elements.
    const panel = source.match(
      /className=\{cn\(([^<>]*)\)\}\s*>\s*<AsciiArtAnimation\s*\/>/
    );
    expect(panel).not.toBeNull();
    expect(panel?.[1]).toMatch(/\bbg-muted\b(?!-)/);
    expect(panel?.[1]).toMatch(/\btext-muted-foreground\b/);
  });
});
