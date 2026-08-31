// @vitest-environment jsdom

import { act as reactAct, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ConnectionIntentInteraction,
  ToolConnection,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectedConnectionIntentInteraction,
  issueThreadInteractionFixtureMeta,
  pendingConnectionIntentInteraction,
  retryConnectionIntentInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { ConnectionIntentInteractionBody } from "./ConnectionIntentInteractionBody";

const setupOptionsMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const declineMock = vi.hoisted(() => vi.fn());
const setPhaseMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/connection-intents", () => ({
  connectionIntentsApi: {
    setupOptions: (...args: unknown[]) => setupOptionsMock(...args),
    complete: (...args: unknown[]) => completeMock(...args),
    decline: (...args: unknown[]) => declineMock(...args),
    setPhase: (...args: unknown[]) => setPhaseMock(...args),
  },
}));

vi.mock("./ConnectionSetupFlow", () => ({
  ConnectionSetupFlow: (props: {
    requestedAgentId?: string;
    existingConnections?: ToolConnection[];
    onUseExisting?: (id: string) => Promise<void>;
    onComplete?: (completion: { connectionId: string }) => void;
    onPhaseChange?: (phase: "needs_retry") => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="shared-connection-setup">
      <span data-testid="requested-agent">{props.requestedAgentId}</span>
      <span data-testid="existing-count">
        {props.existingConnections?.length ?? 0}
      </span>
      {props.existingConnections?.map((connection) => (
        <button
          key={connection.id}
          onClick={() => void props.onUseExisting?.(connection.id)}
        >
          Use {connection.name}
        </button>
      ))}
      <button
        onClick={() => props.onComplete?.({ connectionId: "connection-new" })}
      >
        Connect new
      </button>
      <button onClick={() => props.onPhaseChange?.("needs_retry")}>
        Simulate retry
      </button>
      <button onClick={props.onCancel}>Cancel setup</button>
    </div>
  ),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let queryClient: QueryClient;

async function act(callback: () => void | Promise<void>) {
  await reactAct(callback);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function terminal(
  status: ConnectionIntentInteraction["status"],
  outcome: "declined" | "superseded" | "expired",
): ConnectionIntentInteraction {
  return {
    ...pendingConnectionIntentInteraction,
    id: `interaction-${outcome}`,
    status,
    resolvedAt: new Date("2026-08-26T12:00:00.000Z"),
    result: { version: 1, outcome },
  } as ConnectionIntentInteraction;
}

function renderBody(
  interaction: ConnectionIntentInteraction = pendingConnectionIntentInteraction,
  currentUserId:
    string | null = issueThreadInteractionFixtureMeta.currentUserId,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  void act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ConnectionIntentInteractionBody
          interaction={interaction}
          currentUserId={currentUserId}
          addresseeLabel="Carol"
        />
      </QueryClientProvider>,
    );
  });
  return host;
}

function button(label: string) {
  return Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  setupOptionsMock.mockReset();
  completeMock.mockReset();
  declineMock.mockReset();
  setPhaseMock.mockReset();
  setupOptionsMock.mockResolvedValue({
    requestedAgentId:
      pendingConnectionIntentInteraction.payload.requestingAgentId,
    existingConnections: [],
  });
  completeMock.mockResolvedValue({});
  declineMock.mockResolvedValue({});
  setPhaseMock.mockResolvedValue({});
});

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  host?.remove();
  document.body
    .querySelectorAll("[data-radix-focus-guard]")
    .forEach((node) => node.remove());
  root = null;
  host = null;
});

describe("ConnectionIntentInteractionBody states and audience", () => {
  it.each([
    [pendingConnectionIntentInteraction, "Connect / Use existing"],
    [
      {
        ...pendingConnectionIntentInteraction,
        payload: {
          ...pendingConnectionIntentInteraction.payload,
          phase: "authorizing",
        },
      },
      "Authorizing…",
    ],
    [retryConnectionIntentInteraction, "Try again"],
    [connectedConnectionIntentInteraction, "Notion connected"],
    [terminal("rejected", "declined"), "Connection declined"],
    [terminal("expired", "superseded"), "Request superseded"],
    [terminal("expired", "expired"), "Connection request expired"],
  ] as const)("renders the %s state", (interaction, expected) => {
    renderBody(interaction as ConnectionIntentInteraction);
    expect(document.body.textContent).toContain(expected);
  });

  it("shows non-addressees only the waiting state and never loads setup", () => {
    renderBody(pendingConnectionIntentInteraction, "other-user");
    expect(document.body.textContent).toContain("Waiting for Carol");
    expect(button("Connect / Use existing")).toBeUndefined();
    expect(button("Not now")).toBeUndefined();
    expect(setupOptionsMock).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toMatch(
      /authorizationUrl|bearer|credential/i,
    );
  });
});

describe("ConnectionIntentInteractionBody dialog behavior", () => {
  it("shows loading, then passes existing choices and the locked requesting agent to the shared flow", async () => {
    let resolveSetup!: (value: unknown) => void;
    setupOptionsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSetup = resolve;
      }),
    );
    renderBody();

    await act(() => button("Connect / Use existing")?.click());
    expect(document.body.textContent).toContain("Loading connection options…");

    await act(async () => {
      resolveSetup({
        requestedAgentId: "agent-requesting",
        existingConnections: [
          { id: "connection-one", name: "Carol's Notion" },
          { id: "connection-two", name: "Team Notion" },
        ],
      });
    });
    await flush();

    expect(
      document.querySelector('[data-testid="requested-agent"]')?.textContent,
    ).toBe("agent-requesting");
    expect(
      document.querySelector('[data-testid="existing-count"]')?.textContent,
    ).toBe("2");
    expect(button("Use Carol's Notion")).toBeDefined();
    expect(button("Use Team Notion")).toBeDefined();
    expect(button("Connect new")).toBeDefined();
  });

  it("keeps a load failure open and recovers through the query retry", async () => {
    setupOptionsMock.mockRejectedValueOnce(new Error("setup unavailable"));
    renderBody();
    await act(() => button("Connect / Use existing")?.click());
    await flush();

    expect(document.body.textContent).toContain(
      "Couldn’t load connection setup",
    );
    expect(document.body.textContent).toContain("setup unavailable");
    setupOptionsMock.mockResolvedValueOnce({
      requestedAgentId: "agent-requesting",
      existingConnections: [],
    });
    await act(() => button("Try again")?.click());
    await flush();
    expect(
      document.querySelector('[data-testid="shared-connection-setup"]'),
    ).not.toBeNull();
  });

  it("completes an existing connection, closes, restores focus, and invalidates each task query once", async () => {
    setupOptionsMock.mockResolvedValue({
      requestedAgentId: "agent-requesting",
      existingConnections: [{ id: "connection-one", name: "Carol's Notion" }],
    });
    renderBody();
    const trigger = button("Connect / Use existing")!;
    const invalidation = vi.spyOn(queryClient, "invalidateQueries");

    await act(() => trigger.click());
    await flush();
    await act(() => button("Use Carol's Notion")?.click());
    await flush();

    expect(completeMock).toHaveBeenCalledWith(
      pendingConnectionIntentInteraction.id,
      "connection-one",
    );
    expect(
      document.querySelector('[data-testid="shared-connection-setup"]'),
    ).toBeNull();
    await waitForAssertion(() =>
      expect(document.activeElement).toBe(
        document.querySelector(
          '[data-testid="connection-intent-focus-target"]',
        ),
      ),
    );
    expect(invalidation).toHaveBeenCalledTimes(2);
    expect(invalidation).toHaveBeenCalledWith({
      queryKey: ["issues", "interactions"],
    });
    expect(invalidation).toHaveBeenCalledWith({
      queryKey: ["issues", "detail"],
    });
  });

  it("keeps the dialog open and surfaces completion failures", async () => {
    completeMock.mockRejectedValue(new Error("install commit failed"));
    renderBody();
    await act(() => button("Connect / Use existing")?.click());
    await flush();
    await act(() => button("Connect new")?.click());
    await flush();

    expect(
      document.querySelector('[data-testid="shared-connection-setup"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[role="alert"]')?.textContent,
    ).toContain("install commit failed");
  });

  it("declines once with pending controls disabled and invalidates each task query once", async () => {
    let finishDecline!: () => void;
    declineMock.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDecline = resolve;
      }),
    );
    renderBody();
    const invalidation = vi.spyOn(queryClient, "invalidateQueries");
    const decline = button("Not now")!;

    await act(() => decline.click());
    await flush();
    expect(decline.disabled).toBe(true);
    decline.click();
    expect(declineMock).toHaveBeenCalledTimes(1);
    await act(async () => finishDecline());
    await flush();

    expect(invalidation).toHaveBeenCalledTimes(2);
  });

  it("turns shared-flow retry signals into the server-authored retry phase", async () => {
    renderBody();
    await act(() => button("Connect / Use existing")?.click());
    await flush();
    await act(() => button("Simulate retry")?.click());
    await flush();
    expect(setPhaseMock).toHaveBeenCalledWith(
      pendingConnectionIntentInteraction.id,
      "needs_retry",
    );
  });
});
