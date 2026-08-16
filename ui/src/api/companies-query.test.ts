import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { companyListQueryOptions } from "./companies-query";
import { ApiError } from "./client";
import { queryKeys } from "../lib/queryKeys";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
  detachInflightList: vi.fn(),
}));

vi.mock("./companies", () => ({
  companiesApi: mockCompaniesApi,
}));

describe("companyListQueryOptions", () => {
  it.each([401, 403])("treats %s company-list failures as unauthorized bootstrap state", async (status) => {
    mockCompaniesApi.list.mockRejectedValueOnce(new ApiError("Board access required", status, { error: "Board access required" }));

    await expect(companyListQueryOptions("user-1").queryFn()).resolves.toEqual({
      companies: [],
      unauthorized: true,
    });
  });
});

describe("company list cache keys", () => {
  it("gives each account its own entry, and a stable one for signed-out", () => {
    expect(companyListQueryOptions("user-1").queryKey).not.toEqual(
      companyListQueryOptions("user-2").queryKey,
    );
    expect(companyListQueryOptions(null).queryKey).toEqual(companyListQueryOptions(null).queryKey);
  });

  it("stays under the `companies` prefix so existing invalidations still reach it", () => {
    expect(companyListQueryOptions("user-1").queryKey.slice(0, 1)).toEqual(queryKeys.companies.all);
  });

  // Coalescing keys on the request path alone, so a `/companies` request issued
  // under the previous session would otherwise answer this one and land the
  // wrong account's list in an account-keyed entry.
  it("refuses to join an in-flight request issued for another account", async () => {
    mockCompaniesApi.list.mockResolvedValueOnce([]);
    await companyListQueryOptions("user-2").queryFn();
    expect(mockCompaniesApi.detachInflightList).toHaveBeenCalled();
  });
});

// 19 call sites invalidate `queryKeys.companies.all` after mutating a company.
// Keying the list deeper only stays safe while that prefix still matches it, so
// this asserts the matching itself rather than the shape of the key.
describe("existing invalidations still reach the account-keyed list", () => {
  it("marks the list stale when the `companies` prefix is invalidated", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = companyListQueryOptions("user-1").queryKey;
    queryClient.setQueryData(key, { companies: [], unauthorized: false });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);

    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });
});
