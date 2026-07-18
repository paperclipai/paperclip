import { z } from "zod";

// Canonical DESIGN.md brand-kit token schema (NEO-138 §A1 / NEO-267).
//
// The artifact is YAML frontmatter (these tokens) + a prose body. Token
// vocabulary is Neoreef-native (David, NEO-173): color roles
// primary/secondary/accent/neutral/semantic, named typography scale, etc. — not
// MD3 naming verbatim. A Stitch/MD3 import shim (./stitch-import.ts) maps foreign
// vocabularies into this one.
//
// `.strict()` is used throughout so unknown keys surface as structured
// validation errors rather than being silently dropped.

export const ASSET_LOGO_ROLES = ["logo_primary", "logo_mark", "logo_mono"] as const;
export type BrandKitLogoRole = (typeof ASSET_LOGO_ROLES)[number];

// #RGB, #RRGGBB, or #RRGGBBAA. Hex is required to be quoted in the artifact so it
// is never mistaken for a YAML comment.
export const hexColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Expected a hex color like \"#1A2B3C\"");

// A color role is either a single hex value or a named shade scale (e.g. 50..900).
export const colorScaleSchema = z.record(hexColorSchema);
export const colorRoleSchema = z.union([hexColorSchema, colorScaleSchema]);

export const colorsSchema = z
  .object({
    primary: colorRoleSchema,
    secondary: colorRoleSchema.optional(),
    accent: colorRoleSchema.optional(),
    neutral: colorRoleSchema.optional(),
    semantic: z.record(hexColorSchema).optional(),
  })
  .strict();

const fontWeightSchema = z.union([z.number(), z.string()]);

export const typeStyleSchema = z
  .object({
    family: z.string().optional(),
    size: z.string().optional(),
    weight: fontWeightSchema.optional(),
    lineHeight: z.string().optional(),
    letterSpacing: z.string().optional(),
  })
  .strict();

export const typographySchema = z
  .object({
    families: z.record(z.string()).optional(),
    scale: z.record(typeStyleSchema),
  })
  .strict();

export const motionSchema = z
  .object({
    durations: z.record(z.string()).optional(),
    easings: z.record(z.string()).optional(),
  })
  .strict();

export const imagerySchema = z
  .object({
    style: z.string().optional(),
    treatments: z.array(z.string()).optional(),
    samples: z.array(z.string()).optional(),
  })
  .strict();

// Concise inline brand narrative (Seth/NEO-174 hybrid): the "who/why" agents
// always need. Long-form lives behind the `narrativeRef` token.
export const narrativeSchema = z
  .object({
    audience: z.string().optional(),
    positioning: z.string().optional(),
    oneLiner: z.string().optional(),
  })
  .strict();

export const voiceSchema = z
  .object({
    audience: z.string().optional(),
    toneAttributes: z.array(z.string()).optional(),
    dosAndDonts: z
      .array(z.object({ do: z.string(), dont: z.string() }).strict())
      .optional(),
    lexicon: z
      .object({
        preferred: z.array(z.string()).optional(),
        blacklist: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    boilerplate: z.string().optional(),
    proofPoints: z.array(z.string()).optional(),
  })
  .strict();

export const assetsSchema = z
  .object({
    logos: z
      .array(z.object({ role: z.enum(ASSET_LOGO_ROLES), src: z.string().min(1) }).strict())
      .optional(),
    fonts: z
      .array(
        z
          .object({
            family: z.string().min(1),
            weight: fontWeightSchema.optional(),
            style: z.string().optional(),
            src: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const brandKitTokensSchema = z
  .object({
    name: z.string().min(1),
    colors: colorsSchema,
    typography: typographySchema.optional(),
    rounded: z.record(z.string()).optional(),
    spacing: z.record(z.string()).optional(),
    elevation: z.record(z.string()).optional(),
    motion: motionSchema.optional(),
    breakpoints: z.record(z.string()).optional(),
    zIndex: z.record(z.number()).optional(),
    imagery: imagerySchema.optional(),
    narrative: narrativeSchema.optional(),
    narrativeRef: z.string().optional(),
    voice: voiceSchema.optional(),
    assets: assetsSchema.optional(),
  })
  .strict();

export type BrandKitTokens = z.infer<typeof brandKitTokensSchema>;
export type BrandKitColors = z.infer<typeof colorsSchema>;
export type BrandKitTypeStyle = z.infer<typeof typeStyleSchema>;
export type BrandKitVoice = z.infer<typeof voiceSchema>;
export type BrandKitNarrative = z.infer<typeof narrativeSchema>;
export type BrandKitAssets = z.infer<typeof assetsSchema>;

// The full parsed artifact: structured tokens + prose body.
export interface BrandKitDocument {
  tokens: BrandKitTokens;
  body: string;
}

// Canonical frontmatter key order used when serializing, so output is stable and
// round-trips byte-for-byte regardless of authoring order.
export const BRAND_KIT_TOKEN_KEY_ORDER: ReadonlyArray<keyof BrandKitTokens> = [
  "name",
  "colors",
  "typography",
  "rounded",
  "spacing",
  "elevation",
  "motion",
  "breakpoints",
  "zIndex",
  "imagery",
  "narrative",
  "narrativeRef",
  "voice",
  "assets",
];
