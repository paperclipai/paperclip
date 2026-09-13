// @vitest-environment jsdom

import { act as reactAct, useState, type ReactNode } from "react";
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

const credentialRender = vi.hoisted(() => vi.fn());
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

vi.mock("@/components/ai-connections/AiConnectionCredentialStep", () => ({
  AiConnectionCredentialStep: (props: { connectionId?: string; name: string; fixedMethod?: boolean; onComplete: (result: {connectionId: string; grantId: string; method: "api_key"}) => void; onCancel: () => void }) => { credentialRender(props); return <div data-testid="shared-ai-credentials">
    <span>{props.name}</span><span>{String(props.fixedMethod)}</span>
    <button onClick={() => props.onComplete({ connectionId: props.connectionId!, grantId: "grant", method: "api_key" })}>Reconnect selected account</button>
    <button onClick={props.onCancel}>Cancel repair</button>
  </div>; },
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

function renderNode(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  void act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        {node}
      </QueryClientProvider>,
    );
  });
  return host;
}

function renderBody(
  interaction: ConnectionIntentInteraction = pendingConnectionIntentInteraction,
  currentUserId:
    string | null = issueThreadInteractionFixtureMeta.currentUserId,
) {
  return renderNode(
    <ConnectionIntentInteractionBody
      interaction={interaction}
      currentUserId={currentUserId}
      addresseeLabel="Carol"
    />,
  );
}

function button(label: string) {
  return Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label || (label === "Connect / Use existing" && candidate.textContent?.trim() === "Connect"),
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
    [pendingConnectionIntentInteraction, "Connect"],
    [
      {
        ...pendingConnectionIntentInteraction,
        payload: {
          ...pendingConnectionIntentInteraction.payload,
          phase: "authorizing",
        },
      },
      "Continue setup",
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

  it("restores focus when completion remounts the intent in a different task host", async () => {
    setupOptionsMock.mockResolvedValue({
      requestedAgentId: "agent-requesting",
      existingConnections: [{ id: "connection-one", name: "Carol's Notion" }],
    });
    const acceptedInteraction = {
      ...pendingConnectionIntentInteraction,
      status: "accepted",
      resolvedAt: new Date("2026-08-26T12:00:00.000Z"),
      result: {
        version: 1,
        outcome: "connected",
        connectionId: "connection-one",
      },
    } as ConnectionIntentInteraction;
    let showAcceptedInteraction!: () => void;

    function RemountingTaskHost() {
      const [interaction, setInteraction] = useState(
        pendingConnectionIntentInteraction,
      );
      showAcceptedInteraction = () => setInteraction(acceptedInteraction);
      return (
        <ConnectionIntentInteractionBody
          key={interaction.status}
          interaction={interaction}
          currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
          addresseeLabel="Carol"
        />
      );
    }

    completeMock.mockImplementation(async () => {
      showAcceptedInteraction();
      return acceptedInteraction;
    });
    renderNode(<RemountingTaskHost />);

    await act(() => button("Connect / Use existing")?.click());
    await flush();
    await act(() => button("Use Carol's Notion")?.click());

    await waitForAssertion(() => {
      const target = document.getElementById(
        `connection-intent-focus-target-${acceptedInteraction.id}`,
      );
      expect(document.body.textContent).toContain("Notion connected");
      expect(document.activeElement).toBe(target);
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


describe("AI repair inside the card", () => {
  const interaction: ConnectionIntentInteraction = { ...pendingConnectionIntentInteraction, payload: { ...pendingConnectionIntentInteraction.payload, purpose: "ai" } };
  const connection = { id: "selected-account", name: "My Codex account", provider: "openai", method: "api_key", ownership: "personal", ownerName: "Dotta", status: "revoked" };
  it("reuses authentication inline, preserves the selected account, cancels with focus, and completes", async () => {
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiRepair: { connection, canReconnect: true } });
    completeMock.mockResolvedValue({ ...interaction, status: "accepted" });
    renderBody(interaction);
    await flush();
    await act(() => button("Fix connection")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="ai-connection-inline-repair"]')?.textContent).toContain("My Codex account");
    await act(() => button("Cancel repair")!.click());
    await waitForAssertion(() => expect(document.activeElement?.getAttribute("data-testid")).toBe("connection-intent-focus-target"));
    expect(completeMock).not.toHaveBeenCalled();
    await act(() => button("Fix connection")!.click());
    await act(() => button("Reconnect selected account")!.click());
    expect(completeMock).toHaveBeenCalledWith(interaction.id, "selected-account");
  });
  it("keeps a late credential save after cancellation from accepting the request", async () => {
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiRepair: { connection, canReconnect: true } });
    renderBody(interaction); await flush();
    await act(() => button("Fix connection")!.click());
    const abandoned = credentialRender.mock.lastCall![0];
    await act(() => button("Cancel repair")!.click());
    await act(() => button("Fix connection")!.click());
    await act(() => abandoned.onComplete({ connectionId: connection.id, grantId: "grant", method: "api_key" }));
    expect(completeMock).not.toHaveBeenCalled();
  });
  it("offers continuation for the restored account without another login", async () => {
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [connection], aiRepair: { connection, canReconnect: true } });
    renderBody(interaction); await flush();
    await act(() => button("Fix connection")!.click());
    expect(document.querySelector('[data-testid="shared-ai-credentials"]')).toBeNull();
    await act(() => button("Continue task")!.click());
    expect(completeMock).toHaveBeenCalledWith(interaction.id, connection.id);
  });
  it("does not let another user reconnect the owner's account", async () => {
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiRepair: { connection, canReconnect: false } });
    renderBody(interaction); await flush();
    await act(() => button("Fix connection")!.click());
    expect(document.body.textContent).toContain("Dotta must reconnect My Codex account");
    expect(document.querySelector('[data-testid="shared-ai-credentials"]')).toBeNull();
  });
  it("does not promise to run without credentials when declined", () => {
    renderBody({ ...interaction, status: "rejected" });
    expect(document.body.textContent).toContain("The task still needs a working AI connection");
    expect(document.body.textContent).not.toContain("can continue without it");
  });
});
