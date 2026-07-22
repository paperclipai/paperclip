import type { AppDefinition } from "@paperclipai/shared";

export type AppGalleryDisplayEntry = AppDefinition & {
  key?: string;
  logoUrl?: string;
  tagline?: string;
  branding?: AppDefinition["branding"];
};

export function appDefinitionSlug(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.slug ?? entry?.key ?? "";
}

export function appDefinitionName(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.name ?? appDefinitionSlug(entry) ?? "App";
}

export function appDefinitionDescription(entry: AppGalleryDisplayEntry | null | undefined): string {
  return entry?.description ?? entry?.tagline ?? "";
}

export function appDefinitionLogoUrl(entry: AppGalleryDisplayEntry | null | undefined): string | undefined {
  return entry?.branding?.logoUrl ?? entry?.logoUrl;
}
