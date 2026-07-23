// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

vi.mock("@/api/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/access")>()),
  accessApi: mockAccessApi,
}));

import { useFeatures } from "./useFeatures";
import { buildCurrentBoardAccess } from "@/test-utils/currentBoardAccess";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function Probe() {
  const { data } = useFeatures();
  return <div data-testid="probe">{data ? `cases:${data.enableCases}` : "loading"}</div>;
}

describe("useFeatures", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("selects capabilities.features from /cli-auth/me", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue(
      buildCurrentBoardAccess({ features: { enableCases: true } }),
    );
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await flush();

    expect(container.textContent).toContain("cases:true");
    expect(mockAccessApi.getCurrentBoardAccess).toHaveBeenCalledTimes(1);

    root.unmount();
  });
});
