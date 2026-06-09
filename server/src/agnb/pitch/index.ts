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
