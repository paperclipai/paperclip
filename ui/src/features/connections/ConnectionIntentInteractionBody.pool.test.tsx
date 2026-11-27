// @vitest-environment jsdom

import { act as reactAct, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ConnectionIntentInteraction,
  ToolConnection,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
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
const routedCredentialRender = vi.hoisted(() => vi.fn());
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

vi.mock("@/components/ai-connections/AiProviderSetup", () => ({
  AiProviderSetup: (props: { reconnect: { id: string }; onComplete: (binding: { connectionId: string; grantId: string; method: "api_key" }) => void; onCancel: () => void }) => {
    routedCredentialRender(props);
    return <div data-testid="routed-ai-repair">
      <button onClick={() => props.onComplete({ connectionId: props.reconnect.id, grantId: "grant", method: "api_key" })}>Reconnect routed account</button>
      <button onClick={props.onCancel}>Cancel routed repair</button>
    </div>;
  },
}));

vi.mock("./ConnectionSetupFlow", () => ({
  ConnectionSetupFlow: (props: {
    requestedAgentId?: string;
    requiredAgentId?: string;
    existingConnections?: ToolConnection[];
    onUseExisting?: (id: string) => Promise<void>;
    onComplete?: (completion: { connectionId: string } | { resolvedByCallback: true }) => void;
    onPhaseChange?: (phase: "needs_retry") => void;
    onCancel?: () => void;
  }) => (
    <div data-testid="shared-connection-setup">
      <span data-testid="requested-agent">{props.requestedAgentId}</span>
      <span data-testid="required-agent">{props.requiredAgentId}</span>
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

describe("AI repair inside the card", () => {
  const interaction: ConnectionIntentInteraction = { ...pendingConnectionIntentInteraction, payload: { ...pendingConnectionIntentInteraction.payload, purpose: "ai" } };
  it("lets the addressed operator dismiss a stale AI request after changing providers", async () => {
    setupOptionsMock.mockRejectedValue(new ApiError("AI configuration changed", 409, { error: "AI configuration changed" }));
    declineMock.mockResolvedValue({ ...interaction, status: "rejected" });
    renderBody(interaction);
    await waitForAssertion(() => expect(button("Fix connection")).toBeDefined());
    await act(() => button("Fix connection")!.click());
    await waitForAssertion(() => expect(button("Dismiss request")).toBeDefined());
    await act(() => button("Dismiss request")!.click());
    expect(declineMock).toHaveBeenCalledWith(interaction.id);
    expect(completeMock).not.toHaveBeenCalled();
    expect(updateAgentMock).not.toHaveBeenCalled();
  });
  it("keeps a temporary setup failure from offering stale-request dismissal", async () => {
    setupOptionsMock.mockRejectedValue(new ApiError("Unavailable", 500, { error: "Unavailable" }));
    renderBody(interaction);
    await waitForAssertion(() => expect(button("Fix connection")).toBeDefined());
    await act(() => button("Fix connection")!.click());
    await waitForAssertion(() => expect(document.body.textContent).toContain("Unavailable"));
    expect(button("Dismiss request")).toBeUndefined();
    expect(declineMock).not.toHaveBeenCalled();
  });
  const connection = { id: "selected-account", name: "My Codex account", provider: "openai", method: "api_key", ownership: "personal", ownerName: "Dotta", status: "revoked" };

});
