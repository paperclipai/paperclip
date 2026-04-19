import { z } from "zod";

const MAX_POSITION = 1_000_000;
const MAX_TITLE_LENGTH = 160;
const MAX_SITE_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 500;

function isHttpQuickLinkUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function deriveProjectQuickLinkTitle(input: { title?: string | null; url: string }) {
  const explicitTitle = input.title?.trim();
  if (explicitTitle) return explicitTitle;
  try {
    const parsed = new URL(input.url);
    return parsed.hostname.replace(/^www\./i, "") || input.url;
  } catch {
    return input.url;
  }
}

export const projectQuickLinkUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(isHttpQuickLinkUrl, "Quick link URL must use http or https.");

function emptyStringToNull(value: unknown) {
  if (typeof value === "string" && value.trim().length === 0) return null;
  return value;
}

const projectQuickLinkTitleSchema = z.string().trim().min(1).max(MAX_TITLE_LENGTH);
const projectQuickLinkPositionSchema = z.number().int().min(0).max(MAX_POSITION);
const projectQuickLinkMetadataTextSchema = (max: number) =>
  z.preprocess(emptyStringToNull, z.string().trim().min(1).max(max).nullable().optional());
const projectQuickLinkMetadataUrlSchema = z.preprocess(
  emptyStringToNull,
  projectQuickLinkUrlSchema.nullable().optional(),
);

export const projectQuickLinkMetadataSchema = z.object({
  siteName: projectQuickLinkMetadataTextSchema(MAX_SITE_NAME_LENGTH),
  description: projectQuickLinkMetadataTextSchema(MAX_DESCRIPTION_LENGTH),
  imageUrl: projectQuickLinkMetadataUrlSchema,
  faviconUrl: projectQuickLinkMetadataUrlSchema,
});

export const previewProjectQuickLinkSchema = z.object({
  url: projectQuickLinkUrlSchema,
}).strict();

export const createProjectQuickLinkSchema = z.object({
  title: projectQuickLinkTitleSchema.optional(),
  url: projectQuickLinkUrlSchema,
  position: projectQuickLinkPositionSchema.optional(),
  ...projectQuickLinkMetadataSchema.shape,
}).strict();

export const updateProjectQuickLinkSchema = z.object({
  title: projectQuickLinkTitleSchema.optional(),
  url: projectQuickLinkUrlSchema.optional(),
  position: projectQuickLinkPositionSchema.optional(),
  ...projectQuickLinkMetadataSchema.shape,
}).strict().refine((value) => Object.keys(value).length > 0, "At least one quick link field is required.");

export type CreateProjectQuickLink = z.infer<typeof createProjectQuickLinkSchema>;
export type PreviewProjectQuickLink = z.infer<typeof previewProjectQuickLinkSchema>;
export type UpdateProjectQuickLink = z.infer<typeof updateProjectQuickLinkSchema>;
