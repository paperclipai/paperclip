import { z } from "zod";

export const DEFAULT_ANNOUNCEMENT_FEED_URL = "https://pages.paperclip.ing/announcements/v1/current.json";
export const ANNOUNCEMENT_MANIFEST_MAX_BYTES = 64 * 1024;
export const ANNOUNCEMENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const ANNOUNCEMENT_ANIMATION_MAX_BYTES = 128 * 1024;
// Used both in the isolated srcdoc and on the asset endpoint. The HTTP
// response additionally applies CSP sandbox (not supported in a meta tag).
export const ANNOUNCEMENT_ANIMATION_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

// Only stable, company-relative board pages. Never API paths, entity IDs, or
// routes that depend on an experimental feature being enabled.
export const ANNOUNCEMENT_APP_ROUTES = [
  "/dashboard", "/issues", "/projects", "/agents", "/skills", "/apps",
  "/routines", "/artifacts", "/company/settings",
] as const;

export const announcementIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/);
const label = z.string().trim().min(1).max(48);
const httpsUrl = z.string().max(2048).url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}, "Use an HTTPS URL without credentials");

export const announcementActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("external"), label, url: httpsUrl }).strict(),
  z.object({ kind: z.literal("route"), label, path: z.enum(ANNOUNCEMENT_APP_ROUTES) }).strict(),
]);

export const announcementSchema = z.object({
  id: announcementIdSchema,
  eyebrow: z.string().trim().min(1).max(48),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(400),
  image: z.object({
    // Immutable, content-addressed raster assets beneath the feed directory.
    path: z.string().regex(/^assets\/[a-f0-9]{64}\.(png|jpg|webp)$/),
    alt: z.string().max(200),
  }).strict().optional(),
  animation: z.object({
    path: z.string().regex(/^assets\/[a-f0-9]{64}\.html$/),
    alt: z.string().trim().min(1).max(200),
  }).strict().optional(),
  secondaryLink: announcementActionSchema.optional(),
  primaryAction: announcementActionSchema,
  expiresAt: z.string().datetime({ offset: true }).optional(),
  minimumPaperclipVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
}).strict().refine((value) => !value.animation || Boolean(value.image), {
  message: "An animation requires a static fallback image", path: ["image"],
});

export const announcementManifestSchema = z.object({
  schemaVersion: z.literal(1),
  announcement: announcementSchema.nullable(),
}).strict();
export const dismissAnnouncementSchema = z.object({ companyId: z.string().uuid() }).strict();
export type AnnouncementAction = z.infer<typeof announcementActionSchema>;
export type Announcement = z.infer<typeof announcementSchema>;
export type AnnouncementManifest = z.infer<typeof announcementManifestSchema>;

export function isAnnouncementEligible(announcement: Announcement, version: string, now = Date.now()): boolean {
  if (announcement.expiresAt && Date.parse(announcement.expiresAt) <= now) return false;
  if (!announcement.minimumPaperclipVersion) return true;
  const installed = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!installed) return false;
  const minimum = announcement.minimumPaperclipVersion.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = Number(installed[i + 1]) - minimum[i]!;
    if (difference !== 0) return difference > 0;
  }
  return !installed[4]; // A prerelease of the minimum is not that release yet.
}
