// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentActionButtons } from "../components/AgentActionButtons";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { RunAccountingMetrics } from "./AgentDetail";
import { hasUnavailableProviderAccounting, supportsRawProviderTrace } from "../lib/utils";

vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));

const unavailable = { providerAccounting: { usage: null, cost: null, externallyBilled: true } };
const run = (usageJson: HeartbeatRun["usageJson"], resultJson: HeartbeatRun["resultJson"] = null) => ({ usageJson, resultJson } as HeartbeatRun);

describe("run accounting provenance", () => {
  it("renders persisted unavailable accounting without zero usage or zero dollars", () => {
    const markup = renderToStaticMarkup(<RunAccountingMetrics run={run({ inputTokens: 0, outputTokens: 0, costUsd: 0 }, unavailable)} />);
    expect(markup.match(/Unavailable/g)).toHaveLength(4);
    expect(markup).not.toContain("$0");
    expect(markup).not.toContain(">0<");
  });

  it("retains reported historical usage independently of the agent's current provider", () => {
    const markup = renderToStaticMarkup(<RunAccountingMetrics run={run({ inputTokens: 120, outputTokens: 20, cachedInputTokens: 40, costUsd: 0.12 })} />);
    expect(markup).toContain("120");
    expect(markup).toContain("20");
    expect(markup).toContain("40");
    expect(markup).toContain("$0.1200");
    expect(markup).not.toContain("Unavailable");
  });

  it("requires the saved externally billed and unavailable facts", () => {
    expect(hasUnavailableProviderAccounting(unavailable)).toBe(true);
    expect(hasUnavailableProviderAccounting(null)).toBe(false);
    expect(hasUnavailableProviderAccounting({ providerAccounting: { usage: null, cost: null } })).toBe(false);
    expect(hasUnavailableProviderAccounting({ providerAccounting: { usage: { inputTokens: 2 }, cost: 1, externallyBilled: true } })).toBe(false);
  });
});


describe("provider trace support", () => {
  const renderActions = (provider: string, isAdmin: boolean) => {
    const agent: Agent = {
      id: "agent-1", companyId: "company-1", name: "Researcher", urlKey: "researcher", role: "researcher",
      title: null, icon: null, status: "active", reportsTo: null, capabilities: null,
      adapterType: "paperclip_runner", adapterConfig: { provider }, runtimeConfig: {},
      budgetMonthlyCents: 0, spentMonthlyCents: 0, permissions: { canCreateAgents: false },
      pauseReason: null, pausedAt: null, lastHeartbeatAt: null, metadata: null,
      createdAt: new Date("2026-10-10T00:00:00Z"), updatedAt: new Date("2026-10-10T00:00:00Z"),
    };
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <AgentActionButtons agent={agent} canRunWithProviderTrace={isAdmin && supportsRawProviderTrace(agent.adapterType, agent.adapterConfig)} />
      </QueryClientProvider>,
    );
  };

  it("keeps normal Muse actions but removes the unsupported raw traffic promise", () => {
    const markup = renderActions("muse", true);
    expect(markup).toContain("Run now");
    expect(markup).toContain("Pause");
    expect(markup).not.toContain("Run with provider trace");
    expect(markup).not.toContain("Capture exact provider traffic");
  });

  it("retains other provider tracing only for authorized administrators", () => {
    expect(renderActions("codex", true)).toContain("Run with provider trace");
    expect(renderActions("openai_dot", true)).toContain("Run with provider trace");
    expect(renderActions("codex", false)).not.toContain("Run with provider trace");
  });
});
