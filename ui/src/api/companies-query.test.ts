import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { companyListQueryOptions, resolveAccountUserId } from "./companies-query";
import { ApiError } from "./client";
import { queryKeys } from "../lib/queryKeys";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("./auth", () => ({
  authApi: mockAuthApi,
}));

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

// A session request that fails answers nothing. `authApi.getSession` returns
// null only for a 401 — a real "signed out" — and throws otherwise, so treating
// a failure as null would key a credentialed response to `anonymous` and hand
// it to every signed-out reader. The original bug, rebuilt for anonymous.
describe("an unavailable session is not an anonymous session", () => {
  it("does not resolve an identity from an errored session entry", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAuthApi.getSession.mockRejectedValueOnce(new Error("network down"));
    await queryClient
      .fetchQuery({ queryKey: queryKeys.auth.session, queryFn: () => mockAuthApi.getSession(), retry: false })
      .catch(() => undefined);
    expect(queryClient.getQueryState(queryKeys.auth.session)?.status).toBe("error");

    // Asked again rather than assumed anonymous.
    mockAuthApi.getSession.mockResolvedValueOnce({ user: { id: "user-9" } });
    await expect(resolveAccountUserId(queryClient)).resolves.toBe("user-9");
  });

  it("fetches the session when the cache has no answer, instead of defaulting to anonymous", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAuthApi.getSession.mockResolvedValueOnce({ user: { id: "user-7" } });

    await expect(resolveAccountUserId(queryClient)).resolves.toBe("user-7");
    expect(mockAuthApi.getSession).toHaveBeenCalled();
  });

  it("still treats a confirmed 401 as the anonymous identity", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // `getSession` resolves null for a 401 — signed out is an answer.
    mockAuthApi.getSession.mockResolvedValueOnce(null);

    await expect(resolveAccountUserId(queryClient)).resolves.toBeNull();
  });
});


// Invalidation is the app saying "that answer belongs to the previous account".
// The entry stays `success` with the old user until a refetch lands, so a status
// check alone would key the new account's list to the old account's id.
describe("an invalidated session is not a current identity", () => {
  it("re-reads the session rather than trusting an invalidated success", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAuthApi.getSession.mockResolvedValueOnce({ user: { id: "user-1" } });
    await queryClient.fetchQuery({
      queryKey: queryKeys.auth.session,
      queryFn: () => mockAuthApi.getSession(),
      retry: false,
    });

    // Signed in as somebody else; the invite page invalidates and asks at once.
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    expect(queryClient.getQueryState(queryKeys.auth.session)?.status).toBe("success");
    mockAuthApi.getSession.mockResolvedValueOnce({ user: { id: "user-2" } });

    await expect(resolveAccountUserId(queryClient)).resolves.toBe("user-2");
  });
});
