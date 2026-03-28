import type { InboxFeedItem } from "@paperclipai/shared";
import { api } from "./client";

export const inboxFeedApi = {
  feed: (companyId: string, limit?: number) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return api.get<InboxFeedItem[]>(
      `/companies/${companyId}/inbox/feed${qs ? `?${qs}` : ""}`,
    );
  },
};
