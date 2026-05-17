import type {
  ClipImportApplyRequest,
  ClipImportApplyResult,
  ClipImportPreviewRequest,
  ClipImportPreviewResult,
  ClipSharePreviewRequest,
  ClipSharePreviewResult,
  PublicClip,
} from "@paperclipai/shared";
import { api } from "./client";

export const clipsApi = {
  listPublic: (params: { q?: string; type?: string; tag?: string; limit?: number } = {}) => {
    const searchParams = new URLSearchParams();
    if (params.q) searchParams.set("q", params.q);
    if (params.type) searchParams.set("type", params.type);
    if (params.tag) searchParams.set("tag", params.tag);
    if (params.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return api.get<PublicClip[]>(`/public/clips${qs ? `?${qs}` : ""}`);
  },
  getPublic: (slug: string) =>
    api.get<PublicClip>(`/public/clips/${encodeURIComponent(slug)}`),
  sharePreview: (companyId: string, payload: ClipSharePreviewRequest) =>
    api.post<ClipSharePreviewResult>(
      `/companies/${encodeURIComponent(companyId)}/clips/share-preview`,
      payload,
    ),
  publish: (companyId: string, payload: Record<string, unknown>) =>
    api.post<{ clip: PublicClip; revision: Record<string, unknown>; creatorProfile: Record<string, unknown> }>(
      `/companies/${encodeURIComponent(companyId)}/clips/publish`,
      payload,
    ),
  importPreview: (companyId: string, payload: ClipImportPreviewRequest) =>
    api.post<ClipImportPreviewResult>(
      `/companies/${encodeURIComponent(companyId)}/clips/import-preview`,
      payload,
    ),
  importClip: (companyId: string, payload: ClipImportApplyRequest) =>
    api.post<ClipImportApplyResult>(
      `/companies/${encodeURIComponent(companyId)}/clips/import`,
      payload,
    ),
};
