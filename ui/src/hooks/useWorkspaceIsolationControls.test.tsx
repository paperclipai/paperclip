// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useWorkspaceIsolationControls } from "./useWorkspaceIsolationControls";

const getHealth = vi.hoisted(() => vi.fn());
vi.mock("@/api/health", () => ({ healthApi: { get: getHealth } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Control() {
  const { visible } = useWorkspaceIsolationControls();
  return visible ? <button>Choose isolation</button> : null;
}

describe("workspace isolation visibility", () => {
  it("stays hidden until health loads and responds to operator policy changes without fetching", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    const root = createRoot(container);
    const setPolicy = async (hiddenSettings: string[]) => {
      await act(async () => {
        client.setQueryData(queryKeys.health, { hiddenSettings });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Control /></QueryClientProvider>));
      expect(container.querySelector("button")).toBeNull();
      await setPolicy(["workspaces.isolation"]);
      expect(container.querySelector("button")).toBeNull();
      await setPolicy([]);
      expect(container.querySelector("button")).not.toBeNull();
      // Hiding an experimental toggle alone does not disable its product controls.
      await setPolicy(["instance.experimental.enableIsolatedWorkspaces"]);
      expect(container.querySelector("button")).not.toBeNull();
      await setPolicy(["workspaces.isolation"]);
      expect(container.querySelector("button")).toBeNull();
      expect(getHealth).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  });
});
