// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDisabledAdaptersSync } from "./use-disabled-adapters";

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

function Probe({ enabled }: { enabled: boolean }) {
  useDisabledAdaptersSync({ enabled });
  return null;
}

describe("useDisabledAdaptersSync", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("does not fetch adapters when disabled", () => {
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe enabled={false} />
        </QueryClientProvider>,
      );
    });

    expect(mockAdaptersApi.list).not.toHaveBeenCalled();
  });
});
