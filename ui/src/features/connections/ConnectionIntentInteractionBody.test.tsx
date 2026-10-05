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

const emailConnectMock = vi.hoisted(() => vi.fn());
const emailSetupMock = vi.hoisted(() => vi.fn());
const emailListMock = vi.hoisted(() => vi.fn());
const emailControlMock = vi.hoisted(() => vi.fn());
const emailCredentialsMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/email", () => ({ emailApi: {
  credentials: (...args: unknown[]) => emailCredentialsMock(...args),
  list: (...args: unknown[]) => emailListMock(...args),
  control: (...args: unknown[]) => emailControlMock(...args),
  connect: (...args: unknown[]) => emailConnectMock(...args),
  setup: (...args: unknown[]) => emailSetupMock(...args),
} }));

const credentialRender = vi.hoisted(() => vi.fn());
const setupOptionsMock = vi.hoisted(() => vi.fn());
const completeMock = vi.hoisted(() => vi.fn());
const declineMock = vi.hoisted(() => vi.fn());
const setPhaseMock = vi.hoisted(() => vi.fn());
const getAgentMock = vi.hoisted(() => vi.fn());
const updateAgentMock = vi.hoisted(() => vi.fn());
const setDefaultMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { setDefault: (...args: unknown[]) => setDefaultMock(...args) } }));
const adoptMock = vi.hoisted(() => vi.fn());
const installMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/tools", () => ({ toolsApi: {
  getConnectionInstalls: async () => ({ installs: [] }),
  putConnectionInstalls: (...args: unknown[]) => installMock(...args),
} }));

vi.mock("@/api/agents", () => ({ agentsApi: {
  adoptAiConnection: (...args: unknown[]) => adoptMock(...args),
  get: (...args: unknown[]) => getAgentMock(...args),
  update: (...args: unknown[]) => updateAgentMock(...args),
} }));

vi.mock("@/api/connection-intents", () => ({
  connectionIntentsApi: {
    setupOptions: (...args: unknown[]) => setupOptionsMock(...args),
    complete: (...args: unknown[]) => completeMock(...args),
    decline: (...args: unknown[]) => declineMock(...args),
    setPhase: (...args: unknown[]) => setPhaseMock(...args),
  },
}));

vi.mock("@/components/ai-connections/AiConnectionCredentialStep", () => ({
  AiConnectionCredentialStep: (props: { connectionId?: string; name: string; hideName?: boolean; fixedMethod?: boolean; onComplete: (result: {connectionId: string; grantId: string; method: "api_key"}) => void; onCancel: () => void }) => { credentialRender(props); return <div data-testid="shared-ai-credentials">
    {!props.hideName && <span>{props.name}</span>}<span>{String(props.fixedMethod)}</span>
    <button onClick={() => props.onComplete({ connectionId: props.connectionId ?? "new-ai-account", grantId: "grant", method: "api_key" })}>Reconnect selected account</button>
    <button onClick={props.onCancel}>Cancel repair</button>
  </div>; },
}));

vi.mock("./ConnectionSetupFlow", () => ({
  ConnectionSetupFlow: (props: {
    requestedAgentId?: string;
    existingConnections?: ToolConnection[];
    onUseExisting?: (id: string) => Promise<void>;
    onComplete?: (completion: { connectionId: string } | { resolvedByCallback: true }) => void;
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
      <button onClick={() => props.onComplete?.({ resolvedByCallback: true })}>Simulate OAuth callback</button>
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
    await flush();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
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
  sessionStorage.clear();
  emailCredentialsMock.mockReset().mockResolvedValue([]);
  emailListMock.mockReset().mockResolvedValue([]);
  emailControlMock.mockReset().mockResolvedValue({});
  emailConnectMock.mockReset().mockResolvedValue({ id: "email-account" });
  emailSetupMock.mockReset().mockResolvedValue({ connectionId: "email-inbox" });
  setDefaultMock.mockReset();
  getAgentMock.mockReset();
  updateAgentMock.mockReset();
  installMock.mockReset();
  adoptMock.mockReset();
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
  await queryClient.cancelQueries();
  queryClient.clear();
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
  it("verifies inline OAuth callback hints against durable server acceptance", async () => {
    const options = { requestedAgentId: pendingConnectionIntentInteraction.payload.requestingAgentId, existingConnections: [], interaction: pendingConnectionIntentInteraction };
    setupOptionsMock.mockResolvedValue(options);
    renderBody();
    await act(() => button("Connect / Use existing")?.click());
    await flush();
    const readsBeforeMessage = setupOptionsMock.mock.calls.length;
    await act(() => button("Simulate OAuth callback")?.click());
    await flush();
    expect(setupOptionsMock.mock.calls.length).toBeGreaterThan(readsBeforeMessage);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
    setupOptionsMock.mockResolvedValue({ ...options, interaction: connectedConnectionIntentInteraction });
    await act(() => button("Simulate OAuth callback")?.click());
    await waitForAssertion(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(completeMock).not.toHaveBeenCalled();
  });

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
  it.each([false, true])("requires atomic validated legacy adoption (validation fails: %s)", async (fails) => {
    const binding = { provider: "openai", method: "subscription", mode: "responsible_user" };
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiConnection: binding, aiConnectionRequiresAdoption: true });
    if (fails) adoptMock.mockRejectedValue(new Error("Connection test failed"));
    else adoptMock.mockResolvedValue({ ...interaction, status: "accepted" });
    renderBody(interaction); await flush();
    await act(() => button("Fix connection")!.click());
    await act(() => button("Reconnect selected account")!.click());
    expect(adoptMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("This replaces the agent’s existing authentication");
    await act(() => button("Use connection and continue")!.click());
    await flush();
    expect(adoptMock).toHaveBeenCalledWith(interaction.payload.requestingAgentId, interaction.id, "new-ai-account", interaction.companyId);
    expect(updateAgentMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    if (fails) expect(document.querySelector('[role="alert"]')?.textContent).toContain("Connection test failed");
  });
  it.each(["anthropic", "openai"])("connects a missing %s default directly in the task", async (provider) => {
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiConnection: { provider, method: "api_key", mode: "responsible_user" } });
    completeMock.mockResolvedValue({ ...interaction, status: "accepted" });
    renderBody(interaction); await flush();
    await act(() => button("Fix connection")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="shared-connection-setup"]')).toBeNull();
    expect(document.querySelector('[data-testid="shared-ai-credentials"]')).not.toBeNull();
    expect(credentialRender.mock.lastCall![0]).toMatchObject({ provider, hideName: true, ownership: "personal", agentIds: [interaction.payload.requestingAgentId], allAgents: false });
    expect(credentialRender.mock.lastCall![0].connectionId).toBeUndefined();
    expect(credentialRender.mock.lastCall![0].fixedMethod).toBeUndefined();
    expect(document.body.textContent).toContain("This task can’t run until");
    await act(() => button("Reconnect selected account")!.click());
    expect(completeMock).toHaveBeenCalledWith(interaction.id, "new-ai-account");
  });
  it("reuses authentication inline, preserves the selected account, cancels with focus, and completes", async () => {
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiRepair: { connection, canReconnect: true } });
    completeMock.mockResolvedValue({ ...interaction, status: "accepted" });
    renderBody(interaction);
    await flush();
    await act(() => button("Fix connection")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="ai-connection-inline-repair"]')?.textContent).not.toContain("My Codex account");
    expect(credentialRender.mock.lastCall![0]).toMatchObject({ name: "My Codex account", hideName: true, fixedMethod: false, connectionId: "selected-account" });
    await act(() => button("Cancel repair")!.click());
    await waitForAssertion(() => expect(document.activeElement?.getAttribute("data-testid")).toBe("connection-intent-focus-target"));
    expect(completeMock).not.toHaveBeenCalled();
    await act(() => button("Fix connection")!.click());
    await act(() => button("Reconnect selected account")!.click());
    expect(completeMock).toHaveBeenCalledWith(interaction.id, "selected-account");
  });
  it.each(["responsible_user", "delegated", "shared"] as const)("selects a different authentication method for a %s binding before resuming", async (mode) => {
    const binding = { provider: "openai", method: "api_key", mode, ...(mode !== "responsible_user" ? { connectionId: connection.id, grantId: "old-grant" } : {}) };
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiConnection: binding, aiRepair: { connection: { ...connection, grantId: "old-grant" }, canReconnect: true } });
    getAgentMock.mockResolvedValue({ id: interaction.payload.requestingAgentId, runtimeConfig: { aiConnection: binding, heartbeat: { enabled: true } } });
    completeMock.mockResolvedValue({ ...interaction, status: "accepted" });
    renderBody(interaction); await flush();
    await act(() => button("Fix connection")!.click());
    await act(() => credentialRender.mock.lastCall![0].onComplete({ connectionId: "new-subscription", grantId: "new-grant", method: "subscription" }));
    await flush();
    if (mode === "responsible_user") {
      expect(setDefaultMock).toHaveBeenCalledWith(interaction.companyId, "new-grant");
      expect(updateAgentMock).not.toHaveBeenCalled();
    } else {
      expect(updateAgentMock).toHaveBeenCalledWith(interaction.payload.requestingAgentId, { runtimeConfig: { heartbeat: { enabled: true }, aiConnection: { ...binding, method: "subscription", connectionId: "new-subscription", grantId: "new-grant" } } }, interaction.companyId);
      expect(setDefaultMock).not.toHaveBeenCalled();
    }
    expect(completeMock).toHaveBeenCalledWith(interaction.id, "new-subscription");
  });
  it("keeps a failed account switch pending and retries the saved account", async () => {
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" }, aiRepair: { connection, canReconnect: true } });
    setDefaultMock.mockRejectedValueOnce(new Error("Could not select this account"));
    renderBody(interaction); await flush();
    await act(() => button("Fix connection")!.click());
    await act(() => credentialRender.mock.lastCall![0].onComplete({ connectionId: "new-subscription", grantId: "new-grant", method: "subscription" }));
    await flush();
    expect(completeMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not select this account");
    await act(() => button("Retry using this connection")!.click());
    await flush();
    expect(completeMock).toHaveBeenCalledWith(interaction.id, "new-subscription");
  });
  it("clears an account-selection retry when its setup is abandoned", async () => {
    setupOptionsMock.mockResolvedValue({ interaction, existingConnections: [], aiConnection: { provider: "openai", method: "api_key", mode: "responsible_user" }, aiRepair: { connection, canReconnect: true } });
    setDefaultMock.mockRejectedValueOnce(new Error("Could not select this account"));
    renderBody(interaction); await flush();
    await act(() => button("Fix connection")!.click());
    await act(() => credentialRender.mock.lastCall![0].onComplete({ connectionId: "new-subscription", grantId: "new-grant", method: "subscription" }));
    await flush();
    expect(button("Retry using this connection")).toBeDefined();
    await act(() => button("Cancel repair")!.click());
    await act(() => button("Fix connection")!.click());
    expect(button("Retry using this connection")).toBeUndefined();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(completeMock).not.toHaveBeenCalled();
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

describe("AgentMail inline setup", () => {
  const interaction: ConnectionIntentInteraction = {
    ...pendingConnectionIntentInteraction,
    payload: { ...pendingConnectionIntentInteraction.payload, purpose: "channel", serviceSlug: "agentmail", serviceName: "AgentMail" },
  };
  async function clickReadyButton(label: string) {
    await waitForAssertion(() => expect(button(label)?.disabled).toBe(false));
    await act(() => button(label)!.click());
    await flush();
  }
  async function enterKey() {
    await waitForAssertion(() => expect(document.querySelector('input[type="password"]')).not.toBeNull());
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-api-key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  it("shows only the key inline, saves company access for this agent and completes after inbox setup", async () => {
    renderBody(interaction);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await waitForAssertion(() => expect(document.querySelectorAll("input")).toHaveLength(1));
    expect(document.querySelector('a[href="https://console.agentmail.to/dashboard/api-keys"]')).not.toBeNull();
    expect(document.querySelector('[role="radiogroup"], select')).toBeNull();
    expect(button("Connect AgentMail")?.disabled).toBe(true);
    await enterKey();
    await clickReadyButton("Connect AgentMail");
    expect(emailConnectMock).toHaveBeenCalledWith(interaction.companyId, {
      apiKey: "fixture-api-key", grantKind: "organization", allAgents: false,
      agentIds: [interaction.payload.requestingAgentId], idempotencyKey: interaction.id,
    });
    expect(emailSetupMock).toHaveBeenCalledWith(interaction.companyId, {
      assignedAgentId: interaction.payload.requestingAgentId, credentialConnectionId: "email-account",
      receiveMode: "websocket", idempotencyKey: interaction.id,
    });
    expect(completeMock).toHaveBeenCalledWith(interaction.id, "email-inbox");
  });
  it("keeps invalid credentials retryable and does not create an inbox or accept the request", async () => {
    emailConnectMock.mockRejectedValueOnce(new Error("AgentMail request failed (401)"));
    renderBody(interaction); await flush(); await enterKey();
    await clickReadyButton("Connect AgentMail");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("401");
    expect(emailSetupMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
    await clickReadyButton("Connect AgentMail");
    expect(completeMock).toHaveBeenCalledTimes(1);
  });
  it("retries inbox setup without asking for or saving the key again", async () => {
    emailSetupMock.mockRejectedValueOnce(new Error("Inbox setup unavailable"));
    renderBody(interaction); await flush(); await enterKey();
    await clickReadyButton("Connect AgentMail");
    expect(completeMock).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await clickReadyButton("Finish setup");
    expect(emailConnectMock).toHaveBeenCalledTimes(1);
    expect(emailSetupMock).toHaveBeenCalledTimes(2);
    expect(completeMock).toHaveBeenCalledWith(interaction.id, "email-inbox");
  });
  it("can choose another key after a saved key fails, retiring an empty draft and preserving the retry identity", async () => {
    emailCredentialsMock.mockResolvedValue([{ id: "saved-account", label: "Saved key", scope: "organization", createdAt: "2026-10-01T14:00:00Z" }]);
    emailSetupMock.mockRejectedValueOnce(new Error("Inbox already assigned"))
      .mockRejectedValueOnce(new Error("Temporary provider failure"));
    emailListMock.mockResolvedValue([{ id: interaction.id, address: null, status: "draft" }]);
    renderBody(interaction); await flush();
    await waitForAssertion(() => expect(button("Connect AgentMail")?.disabled).toBe(false));
    expect((document.querySelector("select") as HTMLSelectElement)?.value).toBe("saved-account");
    expect(emailConnectMock).not.toHaveBeenCalled();
    await clickReadyButton("Connect AgentMail");
    expect(emailConnectMock).not.toHaveBeenCalled();
    await clickReadyButton("Change API key");
    expect(emailControlMock).toHaveBeenCalledWith(interaction.id, "remove");
    await enterKey();
    await clickReadyButton("Connect AgentMail");
    const next = emailSetupMock.mock.calls[1][1].idempotencyKey;
    expect(next).not.toBe(interaction.id);
    expect(emailConnectMock).toHaveBeenCalledWith(interaction.companyId, expect.objectContaining({ idempotencyKey: next }));
    expect(sessionStorage.getItem(`paperclip.agentmail-inline:${interaction.companyId}:${interaction.id}`)).not.toContain("fixture-api-key");
    await act(() => root!.unmount()); host!.remove(); queryClient.clear();
    renderBody(interaction); await flush();
    await clickReadyButton("Finish setup");
    expect(emailSetupMock.mock.calls[2][1].idempotencyKey).toBe(next);
    expect(emailConnectMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledWith(interaction.id, "email-inbox");
  });
  it("does not switch keys after an inbox address is allocated", async () => {
    setupOptionsMock.mockResolvedValue({ existingConnections: [], emailSetup: { credentialConnectionId: "saved-account", readyConnectionId: null } });
    emailListMock.mockResolvedValue([{ id: interaction.id, address: "reserved@example.test", status: "draft" }]);
    renderBody(interaction); await flush();
    await clickReadyButton("Change API key");
    expect(document.body.textContent).toContain("reserved@example.test is already reserved");
    expect(emailControlMock).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
  it("recovers the server-saved account when refresh interrupted its response", async () => {
    const resumedInteraction = { ...interaction, id: "a381e91e-7127-427d-9d2d-519d4deba89f" };
    sessionStorage.setItem(`paperclip.agentmail-inline:${interaction.companyId}:${resumedInteraction.id}`, JSON.stringify({
      setupRequestId: resumedInteraction.id, credentialId: null, inboxConnectionId: null, selectedCredentialId: "",
    }));
    setupOptionsMock.mockResolvedValue({ existingConnections: [], emailSetup: { credentialConnectionId: "server-saved-account", readyConnectionId: null } });
    renderBody(resumedInteraction); await flush();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await clickReadyButton("Finish setup");
    expect(emailConnectMock).not.toHaveBeenCalled();
    expect(emailSetupMock).toHaveBeenCalledWith(interaction.companyId, expect.objectContaining({
      credentialConnectionId: "server-saved-account", idempotencyKey: resumedInteraction.id,
    }));
  });
  it("keeps a different saved-key selection when recovering an interrupted save", async () => {
    const resumedInteraction = { ...interaction, id: "a381e91e-7127-427d-9d2d-519d4deba89f" };
    sessionStorage.setItem(`paperclip.agentmail-inline:${interaction.companyId}:${resumedInteraction.id}`, JSON.stringify({
      setupRequestId: resumedInteraction.id, credentialId: null, inboxConnectionId: null, selectedCredentialId: "selected-account",
    }));
    emailCredentialsMock.mockResolvedValue([{ id: "selected-account", label: "My selected key", scope: "organization", createdAt: "2026-10-01T14:00:00Z" }]);
    setupOptionsMock.mockResolvedValue({ existingConnections: [], emailSetup: { credentialConnectionId: "earlier-account", readyConnectionId: null } });
    renderBody(resumedInteraction); await flush();
    await waitForAssertion(() => expect((document.querySelector('select') as HTMLSelectElement)?.value).toBe("selected-account"));
    await clickReadyButton("Connect AgentMail");
    expect(emailConnectMock).not.toHaveBeenCalled();
    expect(emailSetupMock).toHaveBeenCalledWith(interaction.companyId, expect.objectContaining({
      credentialConnectionId: "selected-account", idempotencyKey: resumedInteraction.id,
    }));
  });
  it("does not restore an abandoned server account after the user changes keys", async () => {
    const replacementRequestId = "a381e91e-7127-427d-9d2d-519d4deba89f";
    sessionStorage.setItem(`paperclip.agentmail-inline:${interaction.companyId}:${interaction.id}`, JSON.stringify({
      setupRequestId: replacementRequestId, credentialId: null, inboxConnectionId: null, selectedCredentialId: "",
    }));
    setupOptionsMock.mockResolvedValue({ existingConnections: [], emailSetup: { credentialConnectionId: "abandoned-account", readyConnectionId: null } });
    renderBody(interaction); await flush(); await enterKey();
    await clickReadyButton("Connect AgentMail");
    expect(emailConnectMock).toHaveBeenCalledWith(interaction.companyId, expect.objectContaining({ idempotencyKey: replacementRequestId }));
    expect(emailSetupMock).toHaveBeenCalledWith(interaction.companyId, expect.objectContaining({
      credentialConnectionId: "email-account", idempotencyKey: replacementRequestId,
    }));
  });
  it("resumes a saved account after reload and retries acceptance without recreating the inbox", async () => {
    setupOptionsMock.mockResolvedValue({ existingConnections: [], emailSetup: { credentialConnectionId: "email-account", readyConnectionId: "email-inbox" } });
    completeMock.mockRejectedValueOnce(new Error("Retry completion"));
    renderBody(interaction); await flush();
    await clickReadyButton("Continue");
    await clickReadyButton("Continue");
    expect(emailConnectMock).not.toHaveBeenCalled();
    expect(emailSetupMock).not.toHaveBeenCalled();
    expect(completeMock).toHaveBeenCalledTimes(2);
  });
  it("declines without provider requests and hides credentials from other viewers", async () => {
    renderBody(interaction); await flush();
    await clickReadyButton("Not now");
    expect(declineMock).toHaveBeenCalledWith(interaction.id);
    expect(emailConnectMock).not.toHaveBeenCalled();
    expect(emailSetupMock).not.toHaveBeenCalled();
    await act(() => root!.render(<QueryClientProvider client={queryClient}><ConnectionIntentInteractionBody interaction={interaction} currentUserId="different-user" addresseeLabel="Carol" /></QueryClientProvider>));
    expect(document.querySelector('input')).toBeNull();
  });
  it("can decline even when inbox setup options fail to load", async () => {
    setupOptionsMock.mockRejectedValue(new Error("Email setup is unavailable"));
    renderBody(interaction);
    await waitForAssertion(() => expect(document.body.textContent).toContain("Email setup is unavailable"));
    await clickReadyButton("Not now");
    expect(declineMock).toHaveBeenCalledWith(interaction.id);
    expect(emailConnectMock).not.toHaveBeenCalled();
  });
});

describe("embedded agent access request", () => {
  const accessRequest = {
    connectionId: "22222222-2222-4222-8222-222222222222",
    connectionName: "Saved Composio",
    tools: [
      { catalogEntryId: "33333333-3333-4333-8333-333333333333", toolName: "COMPOSIO_SEARCH_TOOLS", versionHash: "v1", permission: "allowed" as const },
      { catalogEntryId: "44444444-4444-4444-8444-444444444444", toolName: "COMPOSIO_MANAGE_CONNECTIONS", versionHash: "v1", permission: "ask_first" as const },
    ],
  };
  const interaction: ConnectionIntentInteraction = { ...pendingConnectionIntentInteraction, payload: { ...pendingConnectionIntentInteraction.payload, serviceName: "Composio", accessRequest } };

  it("shows the exact tool permissions before granting inline without a setup modal", async () => {
    setupOptionsMock.mockResolvedValue({ canGrantAccess: true });
    getAgentMock.mockResolvedValue({ id: interaction.payload.requestingAgentId, name: "Researcher" });
    completeMock.mockResolvedValue({ ...interaction, status: "accepted", result: { version: 1, outcome: "connected", connectionId: accessRequest.connectionId } });
    renderBody(interaction);
    await waitForAssertion(() => expect(button("Grant access")?.disabled).toBe(false));
    expect(document.body.textContent).toContain("Grant Researcher access to “Saved Composio”?");
    expect(document.body.querySelector('[data-slot="agent-avatar"]')?.getAttribute("aria-label")).toBe("Researcher");
    expect(Array.from(document.body.querySelectorAll('ul[aria-label="Tool permissions"] li'), row => row.textContent)).toEqual([
      "COMPOSIO_SEARCH_TOOLSAllowed",
      "COMPOSIO_MANAGE_CONNECTIONSAsk first",
    ]);
    expect(completeMock).not.toHaveBeenCalled();
    await act(() => button("Grant access")?.click());
    await waitForAssertion(() => expect(completeMock).toHaveBeenCalledWith(interaction.id, accessRequest.connectionId));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps errors visible and does not allow a non-manager to grant", async () => {
    setupOptionsMock.mockResolvedValue({ canGrantAccess: false });
    renderBody(interaction);
    await waitForAssertion(() => expect(document.body.textContent).toContain("Connection manager required"));
    expect(button("Grant access")?.disabled).toBe(true);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("supports declining and displays permission errors on the card", async () => {
    setupOptionsMock.mockResolvedValue({ canGrantAccess: true });
    completeMock.mockRejectedValue(new Error("Tools changed. Request access again."));
    renderBody(interaction);
    await waitForAssertion(() => expect(button("Grant access")?.disabled).toBe(false));
    await act(() => button("Grant access")?.click());
    await waitForAssertion(() => expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Tools changed"));
    await act(() => button("Not now")?.click());
    await waitForAssertion(() => expect(declineMock).toHaveBeenCalledWith(interaction.id));
  });

  it("shows resolved access and does not expose controls to other users", () => {
    renderBody({ ...interaction, status: "accepted", result: { version: 1, outcome: "connected", connectionId: accessRequest.connectionId } });
    expect(document.body.textContent).toContain("Composio access granted");
    expect(button("Grant access")).toBeUndefined();
  });
});
