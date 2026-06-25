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

function readComponent(file: string): string {
  return readFileSync(path.join(here, file), "utf8");
}

describe("OnboardingWizard decorative panel theming", () => {
  for (const file of ["OnboardingWizard.tsx", "OnboardingWizardClassic.tsx"]) {
    describe(file, () => {
      const source = readComponent(file);

      it("does not hardcode a dark decorative panel background", () => {
        expect(source).not.toContain("bg-[#1d1d1d]");
        expect(source).not.toMatch(/bg-\[#[0-9a-fA-F]{3,8}\]/);
      });

      it("themes the decorative panel with shadcn surface tokens", () => {
        expect(source).toContain("bg-muted text-muted-foreground");
      });
    });
  }
});
