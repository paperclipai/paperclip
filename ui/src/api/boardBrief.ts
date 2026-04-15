import type { BoardBrief, BoardBriefSnapshot } from "@paperclipai/shared";
import { api } from "./client";

export const boardBriefApi = {
  get: (companyId: string) =>
    api.get<BoardBrief>(`/companies/${companyId}/board-brief`),
  history: (
    companyId: string,
    options: { limit?: number; source?: BoardBriefSnapshot["source"] } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.source) params.set("source", options.source);
    const query = params.toString();
    return api.get<BoardBriefSnapshot[]>(
      `/companies/${companyId}/board-brief/history${query ? `?${query}` : ""}`,
    );
  },
};
