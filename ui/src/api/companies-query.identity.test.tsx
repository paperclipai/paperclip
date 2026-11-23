// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { useAccountIdentity } from "./companies-query";
import { queryKeys } from "../lib/queryKeys";

const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./auth", () => ({ authApi: mockAuthApi }));
vi.mock("./companies", () => ({ companiesApi: {} }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useAccountIdentity", () => {
  // After an in-place sign-in the session is invalidated but still holds the previous user until
  // the refetch lands. `settled` stays true then; `current` must not, so callers that read what this
  // tab saved for an account never use the previous account's.
  it("is not current while an invalidated session still names the previous account", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAuthApi.getSession.mockResolvedValueOnce({ user: { id: "user-1" } });
    const seen: Array<{ userId: string | null; settled: boolean; current: boolean }> = [];
    function Probe() {
      const { userId, settled, current } = useAccountIdentity();
      seen.push({ userId, settled, current });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ userId: "user-1", settled: true, current: true }));

    let landSecondSession!: (value: unknown) => void;
    mockAuthApi.getSession.mockReturnValueOnce(new Promise((resolve) => { landSecondSession = resolve; }));
    seen.length = 0;
    await act(async () => { void queryClient.invalidateQueries({ queryKey: queryKeys.auth.session }); });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ userId: "user-1", settled: true, current: false }));
    expect(seen.some((entry) => entry.userId === "user-1" && entry.current)).toBe(false);

    await act(async () => { landSecondSession({ user: { id: "user-2" } }); });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ userId: "user-2", settled: true, current: true }));
    await act(async () => root.unmount());
  });
});
