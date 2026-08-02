import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionFeed } from "@paperclipai/shared";

vi.mock("../api/attention", () => ({
  attentionApi: { list: vi.fn() },
}));

import { attentionApi } from "../api/attention";
import { listAllQueueAttention } from "./DecisionQueuePage";

function page(ids: string[], nextCursor: string | null): AttentionFeed {
  return {
    companyId: "company-1",
    generatedAt: "2026-08-02T00:00:00.000Z",
    totalCount: ids.length,
    decideNowCount: ids.length,
    countsBySourceKind: {} as AttentionFeed["countsBySourceKind"],
    items: ids.map((id) => ({ id })) as AttentionFeed["items"],
    nextCursor,
  };
}

describe("listAllQueueAttention", () => {
  beforeEach(() => {
    vi.mocked(attentionApi.list).mockReset();
  });

  it("loads every queue page before bulk actions are offered", async () => {
    vi.mocked(attentionApi.list)
      .mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, index) => `first-${index}`), "page-2"))
      .mockResolvedValueOnce(page(Array.from({ length: 25 }, (_, index) => `second-${index}`), null));

    const result = await listAllQueueAttention("company-1", "launches");

    expect(result.items).toHaveLength(125);
    expect(attentionApi.list).toHaveBeenNthCalledWith(1, "company-1", {
      queue: "launches",
      limit: 100,
      cursor: undefined,
    });
    expect(attentionApi.list).toHaveBeenNthCalledWith(2, "company-1", {
      queue: "launches",
      limit: 100,
      cursor: "page-2",
    });
  });

  it("rejects a repeated pagination cursor", async () => {
    vi.mocked(attentionApi.list).mockResolvedValue(page([], "same-cursor"));

    await expect(listAllQueueAttention("company-1", "launches")).rejects.toThrow(
      "Attention pagination returned a repeated cursor",
    );
    expect(attentionApi.list).toHaveBeenCalledTimes(2);
  });
});
