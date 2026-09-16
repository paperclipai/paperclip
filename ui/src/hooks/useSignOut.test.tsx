// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { isAccountScopedQueryKey, useSignOut } from "./useSignOut";

const mockAuthApi = vi.hoisted(() => ({ signOut: vi.fn() }));
const mockNavigateTopLevel = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: mockNavigateTopLevel }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let captured: ReturnType<typeof useSignOut> | null = null;

function Harness({ onSignedOut }: { onSignedOut?: () => void }) {
  captured = useSignOut({ onSignedOut });
  return null;
}

describe("useSignOut", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    captured = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  function renderHarness(onSignedOut?: () => void) {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness onSignedOut={onSignedOut} />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("closes caller chrome and navigates through Cloud without local sign-out", async () => {
    const onSignedOut = vi.fn();
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: {
        managed: true,
        managedBy: "paperclip-cloud",
        stackSlug: "acme",
        cloudBaseUrl: "https://cloud.example.test",
      },
    });
    const root = renderHarness(onSignedOut);

    flushSync(() => captured?.mutate());

    await vi.waitFor(() => expect(mockNavigateTopLevel).toHaveBeenCalledOnce());
    expect(mockNavigateTopLevel).toHaveBeenCalledWith("/cloud/logout");
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(mockAuthApi.signOut).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });

  it("keeps self-hosted sign-out pending until the local request finishes, then clears account caches", async () => {
    let resolveSignOut: (() => void) | undefined;
    mockAuthApi.signOut.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSignOut = resolve;
    }));
    queryClient.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "authenticated" });
    queryClient.setQueryData(queryKeys.auth.session, { session: { id: "session-1" } });
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [{ id: "company-a", name: "Account A Co" }],
      unauthorized: false,
    });
    queryClient.setQueryData(queryKeys.access.currentBoardAccess, {
      isInstanceAdmin: false,
      companyIds: ["company-a"],
    });
    queryClient.setQueryData(queryKeys.issues.list("company-a"), [{ id: "issue-a" }]);
    const onSignedOut = vi.fn();
    const root = renderHarness(onSignedOut);

    flushSync(() => captured?.mutate());

    await vi.waitFor(() => expect(captured?.isPending).toBe(true));
    expect(mockAuthApi.signOut).toHaveBeenCalledOnce();
    expect(mockNavigateTopLevel).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();

    resolveSignOut?.();
    await vi.waitFor(() => expect(captured?.isPending).toBe(false));

    expect(captured?.error).toBeNull();
    expect(onSignedOut).toHaveBeenCalledOnce();

    // Account-scoped entries are gone outright, not merely marked stale. An
    // invalidated entry keeps serving its old value until a refetch succeeds,
    // which is the leak this guards.
    expect(queryClient.getQueryData(queryKeys.auth.session)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.companies.all)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.access.currentBoardAccess)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.issues.list("company-a"))).toBeUndefined();

    // Health describes the instance, not the account, and several observers
    // read it with `enabled: false`. It is refreshed in place.
    expect(queryClient.getQueryData(queryKeys.health)).toEqual({
      status: "ok",
      deploymentMode: "authenticated",
    });
    expect(queryClient.getQueryState(queryKeys.health)?.isInvalidated).toBe(true);

    flushSync(() => root.unmount());
  });

  it("leaves the previous account nothing to read when the next account's refetch fails", async () => {
    // The end-to-end shape of the leak. Account A's company list is in cache,
    // A signs out, B signs in, and B's companies request fails.
    // `companiesListQueryOptions` sets `retry: false`, so that single failure
    // is final — and under `invalidateQueries` the observer would still be
    // holding A's list, which consumers read as "this account owns these
    // companies".
    mockAuthApi.signOut.mockResolvedValue(undefined);
    queryClient.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "authenticated" });

    const companiesQueryFn = vi
      .fn()
      .mockResolvedValueOnce({
        companies: [{ id: "company-a", name: "Account A Co" }],
        unauthorized: false,
      })
      .mockRejectedValue(new Error("refetch failed for the new account"));

    // A live observer, standing in for CompanyProvider — which sits above the
    // router and stays mounted across the whole sign-out/sign-in cycle, so it
    // never gets a fresh mount to clear it.
    let observed: unknown = "unset";
    function CompaniesObserver() {
      const { data } = useQuery({
        queryKey: queryKeys.companies.all,
        queryFn: companiesQueryFn,
        retry: false,
      });
      observed = data;
      return null;
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
          <CompaniesObserver />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await vi.waitFor(() =>
        expect(observed).toEqual({
          companies: [{ id: "company-a", name: "Account A Co" }],
          unauthorized: false,
        }),
      );
    });

    await act(async () => {
      captured?.mutate();
      // The sign-out resolves, its cache reset fires, and the refetch that
      // reset kicks off is the one that fails.
      await vi.waitFor(() => expect(captured?.isSuccess).toBe(true));
      await vi.waitFor(() => expect(companiesQueryFn).toHaveBeenCalledTimes(2));
    });

    expect(queryClient.getQueryData(queryKeys.companies.all)).toBeUndefined();
    expect(observed).toBeUndefined();

    await act(async () => {
      root.unmount();
    });
  });

  it("exposes a stable error without closing chrome or clearing caches", async () => {
    mockAuthApi.signOut.mockRejectedValue(new Error("Sign-out request failed"));
    queryClient.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "authenticated" });
    queryClient.setQueryData(queryKeys.auth.session, { session: { id: "session-1" } });
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [{ id: "company-a", name: "Account A Co" }],
      unauthorized: false,
    });
    const onSignedOut = vi.fn();
    const root = renderHarness(onSignedOut);

    flushSync(() => captured?.mutate());

    await vi.waitFor(() => expect(captured?.error?.message).toBe("Sign-out request failed"));
    expect(captured?.isPending).toBe(false);
    expect(onSignedOut).not.toHaveBeenCalled();
    // The account is still signed in, so its caches must survive intact —
    // a failed sign-out must not blank the app the user is still using.
    expect(queryClient.getQueryData(queryKeys.auth.session)).toEqual({ session: { id: "session-1" } });
    expect(queryClient.getQueryData(queryKeys.companies.all)).toEqual({
      companies: [{ id: "company-a", name: "Account A Co" }],
      unauthorized: false,
    });
    expect(queryClient.getQueryState(queryKeys.auth.session)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.health)?.isInvalidated).toBe(false);

    flushSync(() => root.unmount());
  });

  it("leaves the Cloud cache to the document reload rather than clearing it locally", async () => {
    // The Cloud path never reaches onSuccess's clearing branch: it hands off to
    // a top-level navigation, and the resulting document load builds a new
    // QueryClient from scratch. Clearing here would only blank the UI during
    // the frames before that navigation commits.
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: {
        managed: true,
        managedBy: "paperclip-cloud",
        stackSlug: "acme",
        cloudBaseUrl: "https://cloud.example.test",
      },
    });
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [{ id: "company-a", name: "Account A Co" }],
      unauthorized: false,
    });
    const root = renderHarness();

    flushSync(() => captured?.mutate());

    await vi.waitFor(() => expect(mockNavigateTopLevel).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(queryKeys.companies.all)).toEqual({
      companies: [{ id: "company-a", name: "Account A Co" }],
      unauthorized: false,
    });

    flushSync(() => root.unmount());
  });
});

describe("isAccountScopedQueryKey", () => {
  it("keeps only the instance-scoped health entry", () => {
    expect(isAccountScopedQueryKey(queryKeys.health)).toBe(false);
  });

  it("treats every other key root as account-scoped, including ones added later", () => {
    expect(isAccountScopedQueryKey(queryKeys.companies.all)).toBe(true);
    expect(isAccountScopedQueryKey(queryKeys.auth.session)).toBe(true);
    expect(isAccountScopedQueryKey(queryKeys.access.currentBoardAccess)).toBe(true);
    expect(isAccountScopedQueryKey(queryKeys.issues.list("company-a"))).toBe(true);
    expect(isAccountScopedQueryKey(queryKeys.secrets.list("company-a"))).toBe(true);
    expect(isAccountScopedQueryKey(["some-key-nobody-has-written-yet"])).toBe(true);
  });
});
