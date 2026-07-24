// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuiltInAgentGate } from "./BuiltInAgentGate";
import type { BuiltInAgentState, BuiltInAgentStatus } from "@/api/builtInAgents";

const listMock = vi.hoisted(() => vi.fn());
const resumeMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/builtInAgents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/builtInAgents")>();
  return {
    ...actual,
    builtInAgentsApi: { list: listMock, provision: vi.fn(), reset: vi.fn() },
  };
});

vi.mock("@/api/agents", () => ({
  agentsApi: { resume: resumeMock },
}));

// The configure modal pulls in the full AgentConfigForm; stub it so the gate
// test stays focused on state selection.
vi.mock("@/components/ConfigureBuiltInAgentModal", () => ({
  ConfigureBuiltInAgentModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="configure-modal" /> : null,
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

function makeState(status: BuiltInAgentStatus, overrides: Partial<BuiltInAgentState> = {}): BuiltInAgentState {
  const provisioned = status !== "not_provisioned";
  return {
    definition: {
      key: "briefs",
      displayName: "Briefs Agent",
      featureKeys: ["briefs"],
      shortPurpose: "Prepares briefs.",
      defaultInstructions: "…",
      defaultRole: "general",
      allowedAdapterTypes: ["codex_local"],
      defaultBudgetMonthlyCents: 0,
    },
    status,
    agentId: provisioned ? "agent-1" : null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: provisioned
      ? ({ id: "agent-1", pausedAt: status === "paused" ? new Date().toISOString() : null } as any)
      : null,
    pauseReason: null,
    ...overrides,
  };
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("BuiltInAgentGate (PAP-12978)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderGate() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <BuiltInAgentGate agentKey="briefs" companyId="c1" featureLabel="Briefs">
            <div data-testid="feature">brief content</div>
          </BuiltInAgentGate>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listMock.mockReset();
    resumeMock.mockReset();
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("renders the setup empty-state for needs_setup and hides the feature", async () => {
    listMock.mockResolvedValue([makeState("needs_setup")]);
    await renderGate();
    expect(container.textContent).toContain("Set up the Briefs Agent");
    expect(container.textContent).toContain("Configure its model to enable the feature");
    expect(container.querySelector('[data-testid="feature"]')).toBeNull();
  });

  it("renders the setup empty-state for not_provisioned", async () => {
    listMock.mockResolvedValue([makeState("not_provisioned")]);
    await renderGate();
    expect(container.textContent).toContain("Set up the Briefs Agent");
    expect(container.querySelector('[data-testid="feature"]')).toBeNull();
  });

  it("renders a pending-approval state", async () => {
    listMock.mockResolvedValue([makeState("pending_approval")]);
    await renderGate();
    expect(container.textContent).toContain("pending approval");
    expect(container.querySelector('[data-testid="feature"]')).toBeNull();
  });

  it("shows the paused banner and keeps children readable (stale)", async () => {
    listMock.mockResolvedValue([makeState("paused")]);
    await renderGate();
    expect(container.textContent).toContain("Briefs is paused.");
    expect(container.textContent).toContain("Resume agent");
    // Paused ≠ hidden — children still render.
    expect(container.querySelector('[data-testid="feature"]')).not.toBeNull();
  });

  it("resumes the agent from the paused banner", async () => {
    listMock.mockResolvedValue([makeState("paused")]);
    resumeMock.mockResolvedValue({});
    await renderGate();
    const resumeButton = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Resume agent"),
    );
    expect(resumeButton).toBeTruthy();
    flushSync(() => {
      resumeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    expect(resumeMock).toHaveBeenCalledWith("agent-1", "c1");
  });

  it("renders the feature when ready", async () => {
    listMock.mockResolvedValue([makeState("ready")]);
    await renderGate();
    expect(container.querySelector('[data-testid="feature"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Set up the Briefs Agent");
  });

  it("fails open to the feature when the key is unknown", async () => {
    listMock.mockResolvedValue([makeState("ready", {
      definition: { ...makeState("ready").definition, key: "learning" },
    })]);
    await renderGate();
    expect(container.querySelector('[data-testid="feature"]')).not.toBeNull();
  });
});
