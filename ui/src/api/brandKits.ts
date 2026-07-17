import type { BrandKitTokens } from "@paperclipai/shared";
import { api } from "./client";

// Brand-kit REST client (NEO-271 UI editor over the NEO-269 server API).

export interface BrandKit {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  designMd: string;
  // Server caches the parsed tokens; `{}` for a freshly-created empty kit.
  tokens: Partial<BrandKitTokens> | Record<string, never>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrandKitAssetRef {
  role: string;
  assetId: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  contentPath: string;
}

export interface BrandKitExport {
  format: string;
  kit: { id: string; name: string; slug: string; isDefault: boolean };
  designMd: string;
  tokens: Partial<BrandKitTokens> | Record<string, never>;
  assets: BrandKitAssetRef[];
}

// Shape returned by POST .../assets (attach result).
export interface BrandKitAttachedAsset {
  id: string;
  brandKitId: string;
  assetId: string;
  role: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  contentPath: string;
}

export const brandKitsApi = {
  list: (companyId: string) =>
    api.get<{ brandKits: BrandKit[] }>(`/companies/${companyId}/brand-kits`),

  create: (
    companyId: string,
    data: { name: string; slug?: string; designMd?: string; setDefault?: boolean },
  ) => api.post<BrandKit>(`/companies/${companyId}/brand-kits`, data),

  // Upsert the DESIGN.md artifact; server re-parses/validates and returns the kit.
  updateDesign: (
    companyId: string,
    kitId: string,
    data: { designMd: string; name?: string },
  ) => api.put<BrandKit>(`/companies/${companyId}/brand-kits/${kitId}`, data),

  setDefault: (companyId: string, kitId: string) =>
    api.post<BrandKit>(`/companies/${companyId}/brand-kits/${kitId}/default`, {}),

  export: (companyId: string, kitId: string) =>
    api.get<BrandKitExport>(`/companies/${companyId}/brand-kits/${kitId}/export`),

  // Upload + bind an asset to a kit slot (multipart, field `file`, `role`).
  uploadAsset: async (
    companyId: string,
    kitId: string,
    file: File,
    role: string,
  ) => {
    // Read eagerly so the FormData body is self-contained (see assetsApi note).
    const buffer = await file.arrayBuffer();
    const safeFile = new File([buffer], file.name, { type: file.type });
    const form = new FormData();
    form.append("role", role);
    form.append("file", safeFile);
    return api.postForm<BrandKitAttachedAsset>(
      `/companies/${companyId}/brand-kits/${kitId}/assets`,
      form,
    );
  },

  detachAsset: (companyId: string, kitId: string, assetId: string) =>
    api.delete<void>(`/companies/${companyId}/brand-kits/${kitId}/assets/${assetId}`),
};
