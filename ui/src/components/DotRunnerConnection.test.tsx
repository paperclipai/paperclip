// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DotRunnerConnection } from "./DotRunnerConnection";
import { buildDotSetupPrompt } from "../lib/dot-setup-prompt";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../api/client", () => ({
  api: apiMock,
}));

describe("DotRunnerConnection", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container?.remove();
    container = null;
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.delete.mockReset();
  });

  async function renderConnection() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <DotRunnerConnection
            companyId="11111111-1111-4111-8111-111111111111"
            agentId="22222222-2222-4222-8222-222222222222"
            onBinding={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 10 && !container.textContent?.includes("Event subscription:"); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    return container;
  }

  it("tells the operator to resubscribe, not pair again, when a ready Dot's subscription expired", async () => {
    apiMock.get.mockResolvedValue({
      enabled: true,
      resourceUrl: "https://paperclip.example/mcp/runner",
      binding: {
        id: "33333333-3333-4333-8333-333333333333",
        status: "ready",
        connected: true,
        subscriptionVerified: false,
        subscriptionExpired: true,
        hasPendingChallenge: false,
      },
    });
    const el = await renderConnection();
    expect(el.textContent).toContain("Event subscription: expired");
    expect(el.textContent).toContain("Ask the Dot to subscribe again");
    expect(el.textContent).toContain("You do not need to pair it again");
  });

  it("includes 24-hour subscription renewal guidance in the Dot setup prompt", () => {
    const prompt = buildDotSetupPrompt({
      companyId: "11111111-1111-4111-8111-111111111111",
      agentId: "22222222-2222-4222-8222-222222222222",
      resourceUrl: "https://paperclip.example/mcp/runner",
      pairingCode: "test-pairing-code",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(prompt).toContain("refreshBefore");
    expect(prompt).toContain("Subscribe again with the same arguments before then");
    expect(prompt).toContain("without a new pairing");
  });
});
