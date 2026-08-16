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

  /**
   * The className expression on the wrapper around <AsciiArtAnimation />.
   * Anchoring here keeps both guards on the decorative panel itself - the same
   * tokens appear elsewhere in the wizard. `[^<>]` stops the match spanning
   * into other JSX elements.
   */
  function panelClassNames(): string | null {
    return (
      source.match(/className=\{cn\(([^<>]*)\)\}\s*>\s*<AsciiArtAnimation\s*\/>/)?.[1] ??
      null
    );
  }

  it("gives the decorative panel no background but the muted token", () => {
    // Scoped to the panel, not the file. A file-wide scan would fail this
    // case for a hardcoded colour anywhere else in the wizard, reporting a
    // panel regression that had not happened.
    //
    // Asserted as the complete set of `bg-` classes rather than a list of
    // spellings to forbid. The previous version scanned for `bg-[#rrggbb]`
    // alone, and passed unchanged once master migrated this class to
    // `bg-(--hex-1d1d1d)` - so it guarded nothing at all for a while. A named
    // colour like `bg-black` or `bg-zinc-900` would have slipped through the
    // same way. Naming what is allowed cannot rot like that.
    const panel = panelClassNames();
    expect(panel).not.toBeNull();
    const backgrounds = panel!.match(/\bbg-[^\s"'`,]+/g) ?? [];
    expect(backgrounds).toEqual(["bg-muted"]);
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
