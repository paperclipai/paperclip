import type { BoardApiKeySummary, BoardApiKeyCreated } from "@paperclipai/shared";
import { api } from "./client";

const PATH = "/board-api-keys";

export const boardApiKeysApi = {
  list: () => api.get<BoardApiKeySummary[]>(PATH),
  create: (name: string, expiresInDays?: number | null) =>
    api.post<BoardApiKeyCreated>(PATH, { name, expiresInDays }),
  revoke: (id: string) => api.delete<{ revoked: true; keyId: string }>(`${PATH}/${encodeURIComponent(id)}`),
};
