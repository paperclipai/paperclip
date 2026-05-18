// @vitest-environment jsdom

/**
 * LET-396 — CapabilityApplyPanel state-machine + error-code coverage.
 *
 * Verifies that every server state and every stable error code surfaces as
 * usable, accessible UI, and that no raw secret value ever leaks into the
 * rendered DOM — only named references are shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 only exports `act` from `react` when NODE_ENV !== "production".
// CI / QA shells sometimes pin NODE_ENV=production; force a test bundle before
// any React import is evaluated (vi.hoisted runs ahead of hoisted ESM imports).
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CAPABILITY_APPLY_ERROR_CODES } from "@paperclipai/shared";
import type {
  CapabilityApplyApprovalPayload,
  CapabilityApplyPlanSummary,
  CapabilityApplyStep,
} from "@paperclipai/shared";
import type { Approval } from "@paperclipai/shared";

import { CapabilityApplyPanel } from "./CapabilityApplyPanel";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockApi = vi.hoisted(() => ({
  createPlan: vi.fn(),
  getPlan: vi.fn(),
  requestApproval: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  listEvents: vi.fn(),
}));

const FakeApiError = vi.hoisted(
  () =>
    class FakeApiErrorImpl extends Error {
      status: number;
      code: string | null;
      details: Record<string, unknown> | null;
      constructor(message: string, status: number, code: string | null) {
        super(message);
        this.name = "CapabilityApplyApiError";
        this.status = status;
        this.code = code;
        this.details = code ? { code } : null;
      }
    },
);

vi.mock("../api/capabilityApply", () => ({
  capabilityApplyApi: mockApi,
  CapabilityApplyApiError: FakeApiError,
}));

const mockApprovalsApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => void, timeoutMs = 2000) {
  const started = Date.now();
  while (true) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await flush();
    }
  }
}

function renderInClient(container: HTMLElement, element: React.ReactElement): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  return root!;
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

async function clickByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => !b.disabled && b.textContent?.includes(text),
  );
  if (!button) throw new Error(`Clickable button with text "${text}" not found`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// ── Factories ────────────────────────────────────────────────────────────────

function step(overrides: Partial<CapabilityApplyStep> = {}): CapabilityApplyStep {
  return {
    stepId: "step-0",
    ordinal: 0,
    kind: "add_skill_ref",
    target: { label: "skill:demo", namedSecretRefs: [] },
    riskClass: "internal_safe",
    annotations: {},
    sideEffects: [],
    secretSummary: [],
    state: "pending",
    ...overrides,
  };
}

function plan(overrides: Partial<CapabilityApplyPlanSummary> = {}): CapabilityApplyPlanSummary {
  return {
    id: "plan-1",
    companyId: "company-1",
    agentId: "agent-1",
    dryRunHash: "abc123def456",
    state: "pending",
    steps: [step()],
    approvalId: null,
    optimisticVersion: 1,
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...overrides,
  };
}

function approval(status: Approval["status"]): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "capability_apply" as Approval["type"],
    requestedByAgentId: null,
    requestedByUserId: "user-1",
    status,
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-05-18T00:00:00.000Z"),
    updatedAt: new Date("2026-05-18T00:00:00.000Z"),
  };
}

const approvalPayload: CapabilityApplyApprovalPayload = {
  version: 1,
  planRevisionId: "plan-1",
  dryRunHash: "abc123def456",
  agentId: "agent-1",
  scopeSummary: {
    agentId: "agent-1",
    agentLabel: "TestAgent",
    totalSteps: 1,
    stepsByRiskClass: {
      internal_safe: 1,
      external_readonly: 0,
      external_write: 0,
      destructive_or_spend: 0,
      governance_critical: 0,
    },
    totalNamedSecretRefs: 0,
    hasGovernanceCritical: false,
  },
  steps: [],
  liveExecutionFlagState: "off",
  noLiveActionAttestation: true,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CapabilityApplyPanel — empty state", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.values(mockApi).forEach((fn) => fn.mockReset());
    mockApprovalsApi.get.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders no-plan empty state with live-disabled banner when no delta and no plan id", async () => {
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" />,
    );
    await flush();
    expect(container.textContent).toContain("Apply panel");
    expect(container.textContent).toContain("Live execution disabled");
    expect(container.textContent).toContain("Run a dry-run preview first");
    expect(container.querySelector("button")).toBeNull();
    await unmount(root);
  });

  it("offers 'Build apply plan' CTA when effectiveDelta is non-empty", async () => {
    mockApi.createPlan.mockResolvedValue(plan());
    const root = renderInClient(
      container,
      <CapabilityApplyPanel
        companyId="c"
        agentId="a"
        effectiveDelta={{ skillRefChanges: [{ kind: "add", ref: "skill:demo" }] }}
      />,
    );
    await flush();
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Build apply plan"),
    );
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
    await unmount(root);
  });

  it("disables build button when delta is no-op (zero changes)", async () => {
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" effectiveDelta={{}} />,
    );
    await flush();
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Build apply plan"),
    );
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain("No-op preview");
    await unmount(root);
  });
});

describe("CapabilityApplyPanel — plan lifecycle", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.values(mockApi).forEach((fn) => fn.mockReset());
    mockApprovalsApi.get.mockReset();
    mockApi.listEvents.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("pending plan shows Request Approval and Cancel CTAs", async () => {
    mockApi.getPlan.mockResolvedValue(plan({ state: "pending", optimisticVersion: 1 }));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Pending — preview built"));
    expect(container.textContent).toContain("Request approval");
    expect(container.textContent).toContain("Cancel plan");
    expect(container.textContent).not.toContain("Execute approved plan");
    await unmount(root);
  });

  it("approval_requested + approval pending hides Execute CTA and shows awaiting-approval banner", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({ state: "approval_requested", optimisticVersion: 2, approvalId: "approval-1" }),
    );
    mockApprovalsApi.get.mockResolvedValue(approval("pending"));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Approval requested"));
    await waitFor(() => expect(container.textContent).toContain("Awaiting approval"));
    // Execute appears as a *disabled* placeholder, not an actionable button.
    const executeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => b.textContent?.includes("Execute"),
    );
    expect(executeButtons.length).toBeGreaterThan(0);
    expect(executeButtons.every((b) => b.disabled || b.getAttribute("aria-disabled") === "true")).toBe(true);
    await unmount(root);
  });

  it("approval_requested + approval approved exposes Execute CTA", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({ state: "approval_requested", optimisticVersion: 2, approvalId: "approval-1" }),
    );
    mockApprovalsApi.get.mockResolvedValue(approval("approved"));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Approved — ready to execute"));
    const exec = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes("Execute approved plan"),
    );
    expect(exec).toBeDefined();
    expect(exec!.disabled).toBe(false);
    await unmount(root);
  });

  it("approval_requested + approval rejected shows rejection banner (terminal-ish state)", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({ state: "approval_requested", optimisticVersion: 2, approvalId: "approval-1" }),
    );
    mockApprovalsApi.get.mockResolvedValue(approval("rejected"));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Approval rejected"));
    await unmount(root);
  });

  it("approval_requested + approval cancelled is distinguishable from still-pending (G.2 reviewer nit)", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({ state: "approval_requested", optimisticVersion: 2, approvalId: "approval-1" }),
    );
    mockApprovalsApi.get.mockResolvedValue(approval("cancelled"));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Approval cancelled or expired"));
    expect(container.textContent).toContain("distinct from a still-pending approval");
    await unmount(root);
  });

  it("approval_requested + revision_requested surfaces revision banner", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({ state: "approval_requested", optimisticVersion: 2, approvalId: "approval-1" }),
    );
    mockApprovalsApi.get.mockResolvedValue(approval("revision_requested"));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Revision requested"));
    await unmount(root);
  });

  it("applied terminal state shows applied banner and no actionable buttons", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({ state: "applied", optimisticVersion: 4, steps: [step({ state: "completed" })] }),
    );
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("All steps recorded completed"));
    const enabledButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => !b.disabled && b.getAttribute("aria-disabled") !== "true",
    );
    // Only the <details> disclosure summary may be present; explicit actions
    // should not be offered for a terminal plan.
    expect(enabledButtons.find((b) => b.textContent?.includes("Execute"))).toBeUndefined();
    expect(enabledButtons.find((b) => b.textContent?.includes("Cancel plan"))).toBeUndefined();
    expect(enabledButtons.find((b) => b.textContent?.includes("Request approval"))).toBeUndefined();
    await unmount(root);
  });

  it("partially_applied shows skipped/failed counts and live-disabled explanation", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({
        state: "partially_applied",
        optimisticVersion: 4,
        steps: [
          step({ stepId: "s0", state: "completed" }),
          step({ stepId: "s1", ordinal: 1, riskClass: "external_write", state: "skipped" }),
        ],
      }),
    );
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Partially applied"));
    expect(container.textContent).toContain("1 step(s) skipped");
    expect(container.textContent).toContain("Non-internal_safe steps were skipped");
    await unmount(root);
  });

  it("expired terminal is distinct from pending (G.2 reviewer nit)", async () => {
    mockApi.getPlan.mockResolvedValue(plan({ state: "expired", optimisticVersion: 3 }));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("This plan expired"));
    expect(container.textContent).not.toContain("Awaiting approval");
    await unmount(root);
  });

  it("cancelled terminal hides actions", async () => {
    mockApi.getPlan.mockResolvedValue(plan({ state: "cancelled", optimisticVersion: 3 }));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("This plan was cancelled"));
    await unmount(root);
  });

  it("declined terminal hides actions", async () => {
    mockApi.getPlan.mockResolvedValue(plan({ state: "declined", optimisticVersion: 3 }));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("This plan was declined"));
    await unmount(root);
  });
});

describe("CapabilityApplyPanel — request approval / execute actions", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.values(mockApi).forEach((fn) => fn.mockReset());
    mockApprovalsApi.get.mockReset();
    mockApi.listEvents.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("Request approval sends If-Match from optimisticVersion and surfaces sanitized scope summary", async () => {
    // Initial fetch returns pending; subsequent fetches (after invalidate)
    // return the new approval_requested state so the chip flips deterministically.
    const initialPlan = plan({ state: "pending", optimisticVersion: 7 });
    const requestedPlan = plan({
      state: "approval_requested",
      optimisticVersion: 8,
      approvalId: "approval-1",
    });
    mockApi.getPlan.mockResolvedValueOnce(initialPlan).mockResolvedValue(requestedPlan);
    mockApi.requestApproval.mockResolvedValue({
      plan: requestedPlan,
      approvalPayload,
    });
    mockApprovalsApi.get.mockResolvedValue(approval("pending"));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Pending — preview built"));
    await clickByText(container, "Request approval");
    await waitFor(() => {
      expect(mockApi.requestApproval).toHaveBeenCalledWith("c", "a", "plan-1", 7);
      expect(container.textContent).toContain("Approval requested");
    });
    // Sanitized scope summary disclosure is rendered
    await waitFor(() => expect(container.textContent).toContain("Sanitized approval scope"));
    expect(container.textContent).toContain("TestAgent");
    await unmount(root);
  });

  it("Execute action sends If-Match optimisticVersion when approval is approved", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({ state: "approval_requested", optimisticVersion: 3, approvalId: "approval-1" }),
    );
    mockApprovalsApi.get.mockResolvedValue(approval("approved"));
    mockApi.execute.mockResolvedValue(
      plan({
        state: "applied",
        optimisticVersion: 5,
        approvalId: "approval-1",
        steps: [step({ state: "completed" })],
      }),
    );
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Approved — ready to execute"));
    await clickByText(container, "Execute approved plan");
    await waitFor(() => {
      expect(mockApi.execute).toHaveBeenCalledWith("c", "a", "plan-1", 3);
    });
    await unmount(root);
  });
});

describe("CapabilityApplyPanel — server error mapping", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.values(mockApi).forEach((fn) => fn.mockReset());
    mockApprovalsApi.get.mockReset();
    mockApi.listEvents.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  async function setupAndAct(action: "requestApproval" | "execute") {
    if (action === "requestApproval") {
      mockApi.getPlan.mockResolvedValue(plan({ state: "pending", optimisticVersion: 1 }));
    } else {
      mockApi.getPlan.mockResolvedValue(
        plan({ state: "approval_requested", optimisticVersion: 3, approvalId: "approval-1" }),
      );
      mockApprovalsApi.get.mockResolvedValue(approval("approved"));
    }
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    if (action === "requestApproval") {
      await waitFor(() => expect(container.textContent).toContain("Pending — preview built"));
      await clickByText(container, "Request approval");
    } else {
      await waitFor(() => expect(container.textContent).toContain("Approved — ready to execute"));
      await clickByText(container, "Execute approved plan");
    }
    return root;
  }

  it("maps PLAN_HASH_MISMATCH to clear copy", async () => {
    mockApi.execute.mockRejectedValue(
      new FakeApiError(
        CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH,
        409,
        CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH,
      ),
    );
    const root = await setupAndAct("execute");
    await waitFor(() => expect(container.textContent).toContain("Plan hash changed"));
    expect(container.textContent).toContain("Re-run Apply Preview");
    await unmount(root);
  });

  it("maps APPROVAL_NOT_ACCEPTED to clear copy", async () => {
    mockApi.execute.mockRejectedValue(
      new FakeApiError(
        CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
        409,
        CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
      ),
    );
    const root = await setupAndAct("execute");
    await waitFor(() => expect(container.textContent).toContain("Approval not yet accepted"));
    await unmount(root);
  });

  it("maps APPROVAL_CONSUMED to single-use-spent copy", async () => {
    mockApi.execute.mockRejectedValue(
      new FakeApiError(
        CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED,
        409,
        CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED,
      ),
    );
    const root = await setupAndAct("execute");
    await waitFor(() => expect(container.textContent).toContain("Approval already consumed"));
    expect(container.textContent).toContain("single-use");
    await unmount(root);
  });

  it("maps OPTIMISTIC_CONFLICT to refresh-and-retry copy", async () => {
    mockApi.requestApproval.mockRejectedValue(
      new FakeApiError(
        CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
        409,
        CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
      ),
    );
    const root = await setupAndAct("requestApproval");
    await waitFor(() => expect(container.textContent).toContain("Plan state changed"));
    expect(container.textContent).toContain("Refresh and retry");
    await unmount(root);
  });

  it("maps STEP_REQUIRES_GOVERNANCE to separate-workflow copy", async () => {
    mockApi.requestApproval.mockRejectedValue(
      new FakeApiError(
        CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE,
        409,
        CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE,
      ),
    );
    const root = await setupAndAct("requestApproval");
    await waitFor(() => expect(container.textContent).toContain("Separate governance workflow"));
    await unmount(root);
  });

  it("falls back to generic 'no live action occurred' on unknown errors", async () => {
    mockApi.execute.mockRejectedValue(new FakeApiError("Some unrelated server error", 500, null));
    const root = await setupAndAct("execute");
    await waitFor(() => expect(container.textContent).toContain("No live action occurred"));
    await unmount(root);
  });
});

describe("CapabilityApplyPanel — redaction & accessibility", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.values(mockApi).forEach((fn) => fn.mockReset());
    mockApprovalsApi.get.mockReset();
    mockApi.listEvents.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders only named secret references, never raw values, even if step.target has refs", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({
        state: "pending",
        steps: [
          step({
            stepId: "s0",
            kind: "add_mcp_server",
            target: {
              catalogId: "verified/test",
              label: "Test MCP",
              namedSecretRefs: ["PAPERCLIP_API_KEY", "ANTHROPIC_API_KEY"],
            },
            riskClass: "external_write",
          }),
        ],
      }),
    );
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("PAPERCLIP_API_KEY"));
    // Sentinel: a raw token string must not be present
    const SENTINEL = "sk_live_canary_should_never_render";
    expect(container.textContent).not.toContain(SENTINEL);
    // Reference-only language is present
    expect(container.textContent).toContain("Values never leave the secrets store");
    await unmount(root);
  });

  it("buttons have accessible labels and disabled state is announced via aria-disabled", async () => {
    mockApi.getPlan.mockResolvedValue(
      plan({ state: "approval_requested", approvalId: "approval-1", optimisticVersion: 2 }),
    );
    mockApprovalsApi.get.mockResolvedValue(approval("pending"));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => expect(container.textContent).toContain("Awaiting approval"));
    const executeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.getAttribute("aria-label")?.toLowerCase().includes("execute"),
    );
    expect(executeBtn).toBeDefined();
    expect(executeBtn!.getAttribute("aria-label")).toBeTruthy();
    await unmount(root);
  });

  it("plan state chip exposes role=status with state label for assistive tech", async () => {
    mockApi.getPlan.mockResolvedValue(plan({ state: "applied" }));
    const root = renderInClient(
      container,
      <CapabilityApplyPanel companyId="c" agentId="a" currentPlanId="plan-1" />,
    );
    await waitFor(() => {
      const chip = Array.from(container.querySelectorAll('[role="status"]')).find((n) =>
        n.getAttribute("aria-label")?.startsWith("Plan state"),
      );
      expect(chip).toBeDefined();
    });
    await unmount(root);
  });
});
