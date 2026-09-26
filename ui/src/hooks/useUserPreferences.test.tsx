// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { useUserPreferences } from "./useUserPreferences";
import { queryKeys } from "../lib/queryKeys";

const getPreferences = vi.hoisted(() => vi.fn());
vi.mock("../api/auth", () => ({ authApi: { getSession: vi.fn(), getPreferences } }));

it("does not reuse another account's enabled shortcuts while preferences load", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
  client.setQueryData(queryKeys.auth.preferences("user-1"), { keyboardShortcuts: true });
  getPreferences.mockReturnValue(new Promise(() => {}));
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    return <span>{useUserPreferences().data?.keyboardShortcuts === true ? "enabled" : "disabled"}</span>;
  }
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  expect(container.textContent).toBe("enabled");
  await act(async () => {
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("disabled");
  expect(getPreferences).toHaveBeenCalledWith("user-2");
  await act(async () => root.unmount());
  client.clear();
});


it("disables cached shortcuts when an account-bound refetch is rejected", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
  client.setQueryData(queryKeys.auth.preferences("user-1"), { keyboardShortcuts: true });
  getPreferences.mockRejectedValue(new Error("Account changed. Refresh and try again."));
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    return <span>{useUserPreferences().data?.keyboardShortcuts === true ? "enabled" : "disabled"}</span>;
  }
  await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  expect(container.textContent).toBe("enabled");
  await act(async () => {
    await client.invalidateQueries({ queryKey: queryKeys.auth.preferences("user-1") });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toBe("disabled");
  expect(getPreferences).toHaveBeenCalledWith("user-1");
  expect(client.getQueryData(queryKeys.auth.preferences("user-1"))).toEqual({ keyboardShortcuts: true });
  await act(async () => root.unmount());
  client.clear();
});
