// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { RuntimeFeaturesProvider, useRuntimeFeatures } from "./RuntimeFeaturesContext";

const getRuntimeFeatures = vi.hoisted(() => vi.fn());
vi.mock("@/api/runtimeFeatures", () => ({
  runtimeFeaturesApi: { get: getRuntimeFeatures },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { hasFeature } = useRuntimeFeatures();
  return <div>{hasFeature("apps.access_profiles") ? "profiles enabled" : "profiles disabled"}</div>;
}

describe("RuntimeFeaturesProvider", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("uses bootstrap state on first render and revalidates after lifecycle invalidation", async () => {
    queryClient.setQueryData(
      queryKeys.runtimeFeatures,
      { schemaVersion: 1, hostFeatures: ["apps.access_profiles"] },
      { updatedAt: Date.now() },
    );
    getRuntimeFeatures.mockResolvedValue({ schemaVersion: 1, hostFeatures: [] });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RuntimeFeaturesProvider><Probe /></RuntimeFeaturesProvider>
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toBe("profiles enabled");
    expect(getRuntimeFeatures).not.toHaveBeenCalled();

    await queryClient.invalidateQueries({ queryKey: queryKeys.runtimeFeatures });
    await vi.waitFor(() => expect(container.textContent).toBe("profiles disabled"));
    expect(getRuntimeFeatures).toHaveBeenCalledTimes(1);
  });
});
