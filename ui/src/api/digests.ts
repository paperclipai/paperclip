import { api } from "./client";

export interface DigestEntry {
  topic: string;
  date: string;
  filename: string;
  size: number;
}

export interface DigestsResponse {
  digests: Record<string, DigestEntry[]>;
}

export interface DigestContentResponse {
  content: string;
}

export interface PodcastScriptResponse {
  script: string;
}

export const digestsApi = {
  list: (companyId: string) =>
    api.get<DigestsResponse>(`/companies/${companyId}/digests`),

  getContent: (companyId: string, filename: string) =>
    api.get<DigestContentResponse>(
      `/companies/${companyId}/digests/content?file=${encodeURIComponent(filename)}`,
    ),

  generatePodcastScript: (companyId: string, content: string) =>
    api.post<PodcastScriptResponse>(`/companies/${companyId}/digests/podcast-script`, { content }),
};
