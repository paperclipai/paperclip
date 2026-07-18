import { z } from "zod";
import { ASSET_LOGO_ROLES } from "./schema.js";

// HTTP request validators for the Brand Kit server API (NEO-269 / NEO-138 §A6.3).
// The DESIGN.md token vocabulary itself lives in ./schema.ts; these schemas only
// validate the shape of the REST payloads that wrap it.

// A URL-safe kit slug: lowercase alphanumerics separated by single hyphens.
export const brandKitSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase alphanumerics separated by hyphens");

// Asset roles a kit slot can bind: the fixed logo roles, or a font slot keyed by
// `font:<family>:<weight>` (matches the brand_kit_assets.role convention).
export const brandKitAssetRoleSchema = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (value) =>
      (ASSET_LOGO_ROLES as readonly string[]).includes(value) ||
      /^font:[^:]+:[^:]+$/.test(value),
    "Role must be a logo role (logo_primary|logo_mark|logo_mono) or font:<family>:<weight>",
  );

// Create a new kit in the company library. designMd is optional; when present it
// is parsed/validated server-side and its tokens are cached.
export const createBrandKitRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: brandKitSlugSchema.optional(),
    designMd: z.string().max(200_000).optional(),
    setDefault: z.boolean().optional(),
  })
  .strict();

// Upsert the DESIGN.md artifact for an existing kit. name is an optional rename.
export const upsertBrandKitDesignRequestSchema = z
  .object({
    designMd: z.string().max(200_000),
    name: z.string().min(1).max(120).optional(),
  })
  .strict();

// Bind an already-uploaded asset to a kit slot.
export const attachBrandKitAssetRequestSchema = z
  .object({
    assetId: z.string().uuid(),
    role: brandKitAssetRoleSchema,
  })
  .strict();

export type CreateBrandKitRequest = z.infer<typeof createBrandKitRequestSchema>;
export type UpsertBrandKitDesignRequest = z.infer<typeof upsertBrandKitDesignRequestSchema>;
export type AttachBrandKitAssetRequest = z.infer<typeof attachBrandKitAssetRequestSchema>;
