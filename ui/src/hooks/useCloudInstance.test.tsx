// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudInstanceHealthStatus, HealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { useCloudInstance } from "./useCloudInstance";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let captured: CloudInstanceHealthStatus | null = null;

function Harness() {
  captured = useCloudInstance();
  return null;
}

describe("useCloudInstance", () => {
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
    vi.unstubAllGlobals();
  });

  it("reactively reads the existing health cache without making another request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const cloud: CloudInstanceHealthStatus = {
      managed: true,
      managedBy: "paperclip-cloud",
      stackSlug: "acme",
      cloudBaseUrl: "https://app.paperclip.app",
    };
    queryClient.setQueryData<HealthStatus>(queryKeys.health, { status: "ok", cloud });
    const root = createRoot(container);

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
    });

    expect(captured).toEqual(cloud);
    expect(fetch).not.toHaveBeenCalled();

    queryClient.setQueryData<HealthStatus>(queryKeys.health, { status: "ok" });
    await vi.waitFor(() => expect(captured).toBeNull());
    expect(fetch).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });
});
