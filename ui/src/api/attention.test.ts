import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("./client", () => ({ api: mockApi }));

import { attentionApi } from "./attention";

describe("attentionApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ items: [] });
  });

  it("encodes feed filters, decide sorting, and cursor pagination", async () => {
    await attentionApi.list("company-1", {
      includeDismissed: true,
      activitySince: "2026-08-01T00:00:00.000Z",
      activityUntil: "2026-08-01T23:59:59.999Z",
      queue: "release review",
      sort: "decide",
      cursor: "next/page",
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/attention?includeDismissed=true&activitySince=2026-08-01T00%3A00%3A00.000Z&activityUntil=2026-08-01T23%3A59%3A59.999Z&queue=release+review&sort=decide&cursor=next%2Fpage&limit=25",
    );
  });

  it("omits the query delimiter when no options are supplied", async () => {
    await attentionApi.list("company-1");

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/attention");
  });
});
