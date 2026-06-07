// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgentDialog } from "./NewAgentDialog";

const createCompanyInviteMock = vi.hoisted(() => vi.fn());
const getInviteOnboardingMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listAdaptersMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const closeNewAgentMock = vi.hoisted(() => vi.fn());
const openNewIssueMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const clipboardWriteTextMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newAgentOpen: true,
    closeNewAgent: closeNewAgentMock,
    openNewIssue: openNewIssueMock,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock("../api/access", () => ({
  accessApi: {
    createCompanyInvite: (companyId: string, input: unknown) =>
      createCompanyInviteMock(companyId, input),
    getInviteOnboarding: (token: string) => getInviteOnboardingMock(token),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("../api/adapters", () => ({
  adaptersApi: {
    list: () => listAdaptersMock(),
  },
}));

vi.mock("../adapters", () => ({
  listUIAdapters: () => [{ type: "claude_local" }, { type: "openclaw_gateway" }],
}));

vi.mock("../adapters/metadata", () => ({
  isVisualAdapterChoice: (type: string) => type !== "openclaw_gateway",
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => new Set<string>(),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("NewAgentDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    listAgentsMock.mockResolvedValue([
      { id: "agent-ceo", role: "ceo" },
    ]);
    listAdaptersMock.mockResolvedValue([]);
    createCompanyInviteMock.mockResolvedValue({
      id: "invite-1",
      token: "agent-token",
      inviteUrl: "https://paperclip.local/invite/agent-token",
      expiresAt: "2026-04-20T00:00:00.000Z",
      allowedJoinTypes: "agent",
      humanRole: null,
      onboardingTextUrl: "https://paperclip.local/api/invites/agent-token/onboarding.txt",
      onboardingTextPath: "/api/invites/agent-token/onboarding.txt",
    });
    getInviteOnboardingMock.mockResolvedValue({
      onboarding: {
        connectivity: {
          connectionCandidates: ["https://paperclip.local"],
          testResolutionEndpoint: {
            url: "https://paperclip.local/api/invites/agent-token/test-resolution",
          },
        },
      },
    });

    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("generates an external agent onboarding prompt inside the add-agent modal", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NewAgentDialog />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Add a new agent");
    expect(container.textContent).toContain("Invite an external agent");

    const inviteButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.startsWith("Invite an external agent"),
    );

    await act(async () => {
      inviteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Generate a one-time onboarding prompt");
    expect(container.textContent).not.toContain("Company Invites");

    const generateButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Generate onboarding prompt",
    );

    await act(async () => {
      generateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(createCompanyInviteMock).toHaveBeenCalledWith("company-1", {
      allowedJoinTypes: "agent",
      humanRole: null,
      agentMessage: null,
    });
    expect(getInviteOnboardingMock).toHaveBeenCalledWith("agent-token");
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      expect.stringContaining("You're invited to join an All Gas No Brakes company as an agent."),
    );
    expect(container.textContent).toContain("Agent onboarding prompt");
    expect(container.textContent).toContain("Send this prompt to the external agent");
    expect(container.textContent).not.toContain("Optional message for the agent");
    expect(container.textContent).not.toContain("Generate onboarding prompt");
    expect(pushToastMock).toHaveBeenCalledWith({
      title: "Agent invite created",
      body: "Agent onboarding prompt ready below and copied to clipboard.",
      tone: "success",
    });

    const backButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Back",
    );

    await act(async () => {
      backButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("Optional message for the agent");
    expect(container.textContent).toContain("Generate onboarding prompt");

    await act(async () => {
      root.unmount();
    });
  });
});
