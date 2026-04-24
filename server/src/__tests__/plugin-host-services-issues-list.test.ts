import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";

const mockIssueList = vi.hoisted(() => vi.fn());

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    list: mockIssueList,
  }),
}));

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
      };
    },
  } as any;
}

describe("plugin host services issues.list", () => {
  beforeEach(() => {
    mockIssueList.mockReset();
  });

  it("does not re-apply limit/offset to issue pages returned by the issue service", async () => {
    const expectedPage = [{ id: "issue-101" }, { id: "issue-102" }];
    mockIssueList.mockResolvedValue(expectedPage);

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "linear",
      createEventBusStub(),
    );

    const result = await services.issues.list({
      companyId: "company-1",
      limit: 100,
      offset: 100,
    });

    expect(mockIssueList).toHaveBeenCalledWith("company-1", expect.objectContaining({
      companyId: "company-1",
      limit: 100,
      offset: 100,
    }));
    expect(result).toEqual(expectedPage);
  });
});
