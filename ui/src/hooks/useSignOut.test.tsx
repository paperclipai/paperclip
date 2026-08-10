// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useSignOut } from "./useSignOut";

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

  it("keeps self-hosted sign-out pending until the local request finishes, then invalidates caches", async () => {
    let resolveSignOut: (() => void) | undefined;
    mockAuthApi.signOut.mockImplementation(() => new Promise<void>((resolve) => {
      resolveSignOut = resolve;
    }));
    queryClient.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "authenticated" });
    queryClient.setQueryData(queryKeys.auth.session, { session: { id: "session-1" } });
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
    expect(queryClient.getQueryState(queryKeys.auth.session)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.health)?.isInvalidated).toBe(true);

    flushSync(() => root.unmount());
  });

  it("exposes a stable error without closing chrome or invalidating caches", async () => {
    mockAuthApi.signOut.mockRejectedValue(new Error("Sign-out request failed"));
    queryClient.setQueryData(queryKeys.health, { status: "ok", deploymentMode: "authenticated" });
    queryClient.setQueryData(queryKeys.auth.session, { session: { id: "session-1" } });
    const onSignedOut = vi.fn();
    const root = renderHarness(onSignedOut);

    flushSync(() => captured?.mutate());

    await vi.waitFor(() => expect(captured?.error?.message).toBe("Sign-out request failed"));
    expect(captured?.isPending).toBe(false);
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(queryKeys.auth.session)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(queryKeys.health)?.isInvalidated).toBe(false);

    flushSync(() => root.unmount());
  });
});
