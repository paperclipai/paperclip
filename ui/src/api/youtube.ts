import { api } from "./client";

export interface YoutubeExtraction {
  id: string;
  companyId: string;
  submittedByUserId: string;
  url: string;
  videoId: string | null;
  title: string | null;
  channel: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  durationSec: number | null;
  viewCount: number | null;
  likeCount: number | null;
  tags: string[] | null;
  transcript: string | null;
  transcriptSource: string | null;
  report: string | null;
  status: string; // 'processing' | 'completed' | 'failed'
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export const youtubeApi = {
  list: (companyId: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return api.get<YoutubeExtraction[]>(`/companies/${companyId}/youtube-extractions${qs ? `?${qs}` : ""}`);
  },

  get: (id: string) => api.get<YoutubeExtraction>(`/youtube-extractions/${id}`),

  create: (companyId: string, data: { url: string }) =>
    api.post<YoutubeExtraction>(`/companies/${companyId}/youtube-extractions`, data),

  delete: (id: string) => api.delete<void>(`/youtube-extractions/${id}`),
};
