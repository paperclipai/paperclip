// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hook only needs a company id and the two agent endpoints for these cases;
// everything else is mocked so the probe-cache logic is exercised in isolation.
const testEnvironment = vi.hoisted(() => vi.fn());
const hire = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ setSelectedCompanyId: vi.fn() }),
}));
vi.mock("@/api/agents", () => ({
  agentsApi: {
    testEnvironment,
    hire,
    instructionsBundle: vi.fn(async () => ({ entryFile: "AGENTS.md" })),
    saveInstructionsFile: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
  },
}));
vi.mock("@/api/companies", () => ({ companiesApi: { create: vi.fn() } }));
vi.mock("@/api/goals", () => ({ goalsApi: { create: vi.fn() } }));
vi.mock("@/api/approvals", () => ({ approvalsApi: { approve: vi.fn() } }));
vi.mock("@/api/issues", () => ({ issuesApi: { create: vi.fn() } }));
vi.mock("@/api/projects", () => ({ projectsApi: { create: vi.fn(), list: vi.fn() } }));

import { useOnboardingFlow, type OnboardingFlow } from "./useOnboardingFlow";

const INSTRUCTIONS = {
  companyName: "Acme",
  companyGoal: "Build things",
  growPath: false,
  growWorkflows: "",
  growPainPoints: "",
  growAutomate: "",
  q1: "",
  q2: "",
  q3: "",
  q4: "",
};

function adapter(adapterType: string) {
  return { adapterType, model: "", command: "", args: "", url: "" };
}

describe("useOnboardingFlow adapter environment probe", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let flow: OnboardingFlow;

  function Probe() {
    flow = useOnboardingFlow({ createdCompanyId: "company-1" });
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root!.render(<Probe />);
    });
    testEnvironment.mockResolvedValue({ status: "pass" });
    hire.mockResolvedValue({ agent: { id: "agent-1" }, approval: null });
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("re-probes when the adapter changed since the cached probe ran", async () => {
    // The local flow lets the user pick a different adapter and retry after a
    // failed hire. The first adapter's verdict must not stand in for the second.
    await act(async () => {
      await flow.runAdapterEnvironmentTest(adapter("claude_local"));
    });
    expect(testEnvironment).toHaveBeenCalledTimes(1);

    hire.mockRejectedValueOnce(new Error("hire failed"));
    await act(async () => {
      await flow.hireLeadAgent({
        agentName: "COS",
        adapter: adapter("claude_local"),
        instructions: INSTRUCTIONS,
        requireEnvProbe: true,
      });
    });
    // Same adapter — the cached probe is reused rather than re-run.
    expect(testEnvironment).toHaveBeenCalledTimes(1);

    await act(async () => {
      await flow.hireLeadAgent({
        agentName: "COS",
        adapter: adapter("codex_local"),
        instructions: INSTRUCTIONS,
        requireEnvProbe: true,
      });
    });
    expect(testEnvironment).toHaveBeenCalledTimes(2);
    expect(testEnvironment.mock.calls[1][1]).toBe("codex_local");
    // The probed config and the hired config are the same object of record.
    expect(hire.mock.calls[1][1].adapterConfig).toEqual(
      testEnvironment.mock.calls[1][2].adapterConfig,
    );
  });

  it("probes when no cached result exists", async () => {
    await act(async () => {
      await flow.hireLeadAgent({
        agentName: "COS",
        adapter: adapter("claude_local"),
        instructions: INSTRUCTIONS,
        requireEnvProbe: true,
      });
    });
    expect(testEnvironment).toHaveBeenCalledTimes(1);
  });

  it("clearAdapterEnvResult forces the next hire to re-probe", async () => {
    await act(async () => {
      await flow.runAdapterEnvironmentTest(adapter("claude_local"));
    });
    act(() => {
      flow.clearAdapterEnvResult();
    });
    expect(flow.adapterEnvResult).toBeNull();

    await act(async () => {
      await flow.hireLeadAgent({
        agentName: "COS",
        adapter: adapter("claude_local"),
        instructions: INSTRUCTIONS,
        requireEnvProbe: true,
      });
    });
    expect(testEnvironment).toHaveBeenCalledTimes(2);
  });

  it("does not probe at all when requireEnvProbe is false (cloud flow)", async () => {
    await act(async () => {
      await flow.hireLeadAgent({
        agentName: "COS",
        adapter: adapter("claude_local"),
        instructions: INSTRUCTIONS,
        requireEnvProbe: false,
      });
    });
    expect(testEnvironment).not.toHaveBeenCalled();
  });
});
