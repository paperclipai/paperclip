// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TriggersPanel } from "./TriggersPanel";
import type {
  ConnectionTriggersResponse,
  ConnectionTriggerDeliveriesResponse,
} from "@/api/tools";

const listTriggersMock = vi.hoisted(() => vi.fn());
const getDeliveriesMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listConnectionTriggers: (connectionId: string) => listTriggersMock(connectionId),
    getConnectionTriggerDeliveries: (connectionId: string) => getDeliveriesMock(connectionId),
    createConnectionTrigger: vi.fn(),
    updateConnectionTrigger: vi.fn(),
    deleteConnectionTrigger: vi.fn(),
  },
}));

vi.mock("@/api/routines", () => ({
  routinesApi: { list: () => Promise.resolve([{ id: "routine-1", title: "Nightly sync" }]) },
}));
vi.mock("@/api/plugins", () => ({
  pluginsApi: { list: () => Promise.resolve([{ id: "plugin-1", pluginKey: "linear-relay" }]) },
}));
vi.mock("@/api/issues", () => ({
  issuesApi: {
    listCompact: () =>
      Promise.resolve([
        { id: "issue-1", identifier: "PAP-42", title: "Triage inbound", assigneeAgentId: "agent-1" },
      ]),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

const EMPTY_DELIVERIES: ConnectionTriggerDeliveriesResponse = {
  connectionId: "conn-1",
  summary: {
    counts: { received: 0, forwarded: 0, delivered: 0, failed: 0, deadLetter: 0 },
    lastError: null,
    deadLetters: [],
  },
};

function triggersResponse(
  triggers: ConnectionTriggersResponse["triggers"],
): ConnectionTriggersResponse {
  return { connectionId: "conn-1", triggers };
}

function trigger(overrides: Partial<ConnectionTriggersResponse["triggers"][number]>) {
  return {
    id: "trig-1",
    companyId: "company-1",
    connectionId: "conn-1",
    destinationType: "routine" as const,
    destinationId: "routine-1",
    enabled: true,
    config: {},
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    ...overrides,
  };
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TriggersPanel connectionId="conn-1" appName="Linear" />
      </QueryClientProvider>,
    );
  });
  await flushReact();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  listTriggersMock.mockReset();
  getDeliveriesMock.mockReset();
  getDeliveriesMock.mockResolvedValue(EMPTY_DELIVERIES);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TriggersPanel", () => {
  it("shows the empty state when there are no triggers", async () => {
    listTriggersMock.mockResolvedValue(triggersResponse([]));
    await render();
    expect(container.textContent).toContain("No triggers yet");
    expect(container.textContent).toContain("0/3 used");
  });

  it("lists triggers with kind + resolved destination label", async () => {
    listTriggersMock.mockResolvedValue(
      triggersResponse([
        trigger({ id: "t-routine", destinationType: "routine", destinationId: "routine-1" }),
        trigger({ id: "t-issue", destinationType: "issue_wake", destinationId: "issue-1" }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    );
    await render();
    expect(container.textContent).toContain("Nightly sync");
    expect(container.textContent).toContain("PAP-42 · Triage inbound");
    expect(container.textContent).toContain("2/3 used");
  });

  it("disables Add trigger and shows the limit notice at 3 triggers", async () => {
    listTriggersMock.mockResolvedValue(
      triggersResponse([
        trigger({ id: "a", destinationId: "routine-1" }),
        trigger({ id: "b", destinationType: "plugin_worker", destinationId: "plugin-1" }),
        trigger({ id: "c", destinationType: "issue_wake", destinationId: "issue-1" }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any),
    );
    await render();
    expect(container.textContent).toContain("Limit reached");
    const addButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add trigger"),
    ) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
  });

  it("renders delivery counts, last error, and the dead-letter queue", async () => {
    listTriggersMock.mockResolvedValue(triggersResponse([trigger({})]));
    getDeliveriesMock.mockResolvedValue({
      connectionId: "conn-1",
      summary: {
        counts: { received: 12, forwarded: 10, delivered: 8, failed: 2, deadLetter: 1 },
        lastError: { message: "Relay destination dispatch failed", at: "2026-07-21T01:00:00Z", deliveryId: "dlv-9" },
        deadLetters: [
          {
            id: "dl-1",
            deliveryId: "dlv-9",
            providerSlug: "linear",
            attempt: 10,
            lastError: "Relay issue destination has no assigned agent",
            receivedAt: "2026-07-21T00:30:00Z",
          },
        ],
      },
    } satisfies ConnectionTriggerDeliveriesResponse);
    await render();
    expect(container.textContent).toContain("Received");
    expect(container.textContent).toContain("12");
    expect(container.textContent).toContain("Last error");
    expect(container.textContent).toContain("Relay destination dispatch failed");
    expect(container.textContent).toContain("Dead-letter queue (1)");
    expect(container.textContent).toContain("Relay issue destination has no assigned agent");
  });

  it("shows the no-activity hint when nothing has been delivered", async () => {
    listTriggersMock.mockResolvedValue(triggersResponse([trigger({})]));
    await render();
    expect(container.textContent).toContain("Delivery data appears after this connection sees inbound activity.");
  });

  it("surfaces a load error with a retry affordance", async () => {
    listTriggersMock.mockRejectedValue(new Error("boom"));
    await render();
    expect(container.textContent).toContain("Couldn't load triggers");
    expect(container.textContent).toContain("Try again");
  });
});
