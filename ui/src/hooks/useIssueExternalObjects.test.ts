import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalObjectSummary } from "@paperclipai/shared";
import { externalObjectsApi } from "../api/externalObjects";
import {
  EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE,
  fetchIssueExternalObjectSummariesInBatches,
} from "./useIssueExternalObjects";

vi.mock("../api/externalObjects", () => ({
  externalObjectsApi: {
    getIssueSummaries: vi.fn(),
  },
}));

const emptySummary: ExternalObjectSummary = {
  total: 0,
  byStatusCategory: {},
  byLiveness: {},
  highestSeverity: "neutral",
  objects: [],
};

describe("fetchIssueExternalObjectSummariesInBatches", () => {
  afterEach(() => {
    vi.mocked(externalObjectsApi.getIssueSummaries).mockReset();
  });

  it("chunks bulk summary requests below the server validation cap and merges results", async () => {
    const issueIds = Array.from(
      { length: EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE * 2 + 3 },
      (_entry, index) => `issue-${index}`,
    );
    vi.mocked(externalObjectsApi.getIssueSummaries).mockImplementation(async (_companyId, ids) => ({
      summaries: Object.fromEntries(ids.map((id) => [id, { ...emptySummary, total: id.endsWith("-0") ? 1 : 0 }])),
    }));

    const result = await fetchIssueExternalObjectSummariesInBatches("company-1", issueIds);

    expect(externalObjectsApi.getIssueSummaries).toHaveBeenCalledTimes(3);
    expect(vi.mocked(externalObjectsApi.getIssueSummaries).mock.calls.map((call) => call[1].length)).toEqual([
      EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE,
      EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE,
      3,
    ]);
    expect(Object.keys(result.summaries)).toHaveLength(issueIds.length);
    expect(result.summaries["issue-0"]?.total).toBe(1);
  });
});
