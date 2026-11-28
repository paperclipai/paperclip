import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { activityApi, ISSUE_HISTORY_PAGE_MAX } from "./activity";

const rows = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, runId: `${prefix}-${index}` }));

describe("activityApi full issue history", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
  });

  it("walks the bounded server pages until a short page", async () => {
    const first = rows("a", ISSUE_HISTORY_PAGE_MAX);
    const second = rows("b", ISSUE_HISTORY_PAGE_MAX);
    const last = rows("c", 3);
    mockApi.get.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(last);

    const history = await activityApi.forIssue("PAP-1");

    expect(history).toEqual([...first, ...second, ...last]);
    expect(mockApi.get.mock.calls.map(([path]) => path)).toEqual([
      "/issues/PAP-1/activity?limit=100",
      "/issues/PAP-1/activity?limit=100&before=a-99",
      "/issues/PAP-1/activity?limit=100&before=b-99",
    ]);
  });

  it("walks run history by run id and stops on a short first page", async () => {
    mockApi.get.mockResolvedValueOnce(rows("r", ISSUE_HISTORY_PAGE_MAX)).mockResolvedValueOnce([]);

    await expect(activityApi.runsForIssue("PAP-1")).resolves.toHaveLength(ISSUE_HISTORY_PAGE_MAX);
    expect(mockApi.get).toHaveBeenLastCalledWith("/issues/PAP-1/runs?limit=100&before=r-99");
  });

  it("keeps a full list from a server that ignores the page parameters", async () => {
    const all = rows("a", ISSUE_HISTORY_PAGE_MAX + 20);
    mockApi.get.mockResolvedValue(all);

    await expect(activityApi.forIssue("PAP-1")).resolves.toEqual(all);
    expect(mockApi.get).toHaveBeenCalledTimes(1);
  });

  it("stops when a server that ignores the page parameters repeats the cursor", async () => {
    const all = rows("a", ISSUE_HISTORY_PAGE_MAX);
    mockApi.get.mockResolvedValue(all);

    await expect(activityApi.runsForIssue("PAP-1")).resolves.toEqual(all);
    expect(mockApi.get).toHaveBeenCalledTimes(2);
  });

  it("fails the whole read when a later page fails", async () => {
    mockApi.get.mockResolvedValueOnce(rows("a", ISSUE_HISTORY_PAGE_MAX)).mockRejectedValueOnce(new Error("503"));

    await expect(activityApi.forIssue("PAP-1")).rejects.toThrow("503");
  });
});
