/**
 * Typed bridge to the ported finn-pitch lib (plain `.mjs`, no types).
 * The lib is copied verbatim into dist by the server build; these dynamic
 * imports resolve to `dist/agnb/pitch/lib/*.mjs` at runtime.
 *
 * `generatePitch` shells out to the local `claude` CLI (dev-only — absent on
 * Cloud Run). `renderPitch` is pure and runs anywhere.
 */
export interface PitchDeck {
  deckTitle?: string;
  slides?: Array<Record<string, unknown>>;
  _answers?: Record<string, unknown>;
  [k: string]: unknown;
}

export async function generatePitch(answers: Record<string, unknown>): Promise<PitchDeck> {
  // @ts-expect-error — ported .mjs lib, no declarations
  const mod = await import("./lib/generate.mjs");
  return mod.generate(answers) as Promise<PitchDeck>;
}

export async function renderPitch(deck: PitchDeck): Promise<string> {
  // @ts-expect-error — ported .mjs lib, no declarations
  const mod = await import("./lib/render.mjs");
  return mod.render(deck) as string;
}

/**
 * Render a deck's HTML into a clean 16:9 PDF by screenshotting each live slide
 * via headless Chrome (avoids reveal.js print-pdf's broken page breaks).
 * Dev-only — throws an ENOENT-flavoured error where no Chrome binary exists.
 */
export async function pitchToPdf(html: string): Promise<Buffer> {
  // @ts-expect-error — ported .mjs lib, no declarations
  const mod = await import("./lib/pdf.mjs");
  return mod.deckToPdf(html) as Buffer;
}
