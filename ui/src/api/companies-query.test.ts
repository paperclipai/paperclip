import { describe, expect, it, vi } from "vitest";
import { companiesListQueryOptions } from "./companies-query";
import { ApiError } from "./client";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("./companies", () => ({
  companiesApi: mockCompaniesApi,
}));

describe("companiesListQueryOptions", () => {
  it.each([401, 403])("treats %s company-list failures as unauthorized bootstrap state", async (status) => {
    mockCompaniesApi.list.mockRejectedValueOnce(new ApiError("Board access required", status, { error: "Board access required" }));

    await expect(companiesListQueryOptions.queryFn()).resolves.toEqual({
      companies: [],
      unauthorized: true,
    });
  });
});
