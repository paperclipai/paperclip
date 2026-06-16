// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewaysTab } from "./GatewaysTab";
import { RelativeTime } from "./shared";

const listGatewaysMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGateways: (companyId: string) => listGatewaysMock(companyId),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function gateway(overrides: Partial<ToolMcpGatewayWithTokens> = {}): ToolMcpGatewayWithTokens {
  return {
    id: "gateway-1",
    companyId: "company-1",
    name: "Dotta's MacBook",
    slug: "dottas-macbook",
    description: null,
    status: "active",
    profileId: "profile-1",
    agentId: null,
    projectId: null,
    issueId: null,
    endpointPath: "/api/tool-gateway/gateways/gateway-1/mcp",
    metadata: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    tokens: [],
    clientSnippets: [],
    ...overrides,
  };
}

describe("GatewaysTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-06-16T12:00:00.000Z").getTime());
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(node: ReactNode) {
    root = createRoot(container);
    await act(async () => {
      root.render(node);
    });
    await flushReact();
  }

  it("renders future relative times as an in-prefix and preserves past ago labels", async () => {
    await render(
      <>
        <RelativeTime value="2026-06-18T12:00:00.000Z" />
        <RelativeTime value="2026-06-14T12:00:00.000Z" />
      </>,
    );

    expect(container.textContent).toContain("in 2d");
    expect(container.textContent).toContain("2d ago");
  });

  it("renders token expiry, revocation date, and empty snippets copy", async () => {
    listGatewaysMock.mockResolvedValue({
      gateways: [
        gateway({
          tokens: [
            {
              id: "token-future",
              companyId: "company-1",
              gatewayId: "gateway-1",
              name: "Future token",
              expiresAt: "2026-06-18T12:00:00.000Z",
              lastUsedAt: null,
              revokedAt: null,
              createdByAgentId: null,
              createdByUserId: "user-1",
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
            {
              id: "token-revoked",
              companyId: "company-1",
              gatewayId: "gateway-1",
              name: "Revoked token",
              expiresAt: "2026-06-18T12:00:00.000Z",
              lastUsedAt: null,
              revokedAt: "2026-06-16T09:00:00.000Z",
              createdByAgentId: null,
              createdByUserId: "user-1",
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          ],
          clientSnippets: [],
        }),
      ],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={client}>
        <GatewaysTab companyId="company-1" />
      </QueryClientProvider>,
    );

    expect(container.textContent).toContain("expires in 2d");
    expect(container.textContent).not.toContain("expires 2d ago");
    expect(container.textContent).toContain("revoked 3h ago");
    expect(container.textContent).toContain("No snippets available.");
  });
});
