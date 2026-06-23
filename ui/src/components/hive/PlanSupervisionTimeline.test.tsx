// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanSupervisionTimeline } from "./PlanSupervisionTimeline";

const mockPlansApi = vi.hoisted(() => ({
  supervisionNotes: vi.fn(),
  supervisionHealth: vi.fn(),
  monitorNow: vi.fn(),
  takeAction: vi.fn(),
}));

vi.mock("../../api/plans", () => ({ plansApi: mockPlansApi }));
vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

async function flushReact() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function render(planState: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PlanSupervisionTimeline planIssueId="plan-1" planState={planState} />
      </QueryClientProvider>,
    );
  });
  return { root, container };
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}

describe("PlanSupervisionTimeline", () => {
  beforeEach(() => {
    mockPlansApi.supervisionNotes.mockResolvedValue({ notes: [] });
    mockPlansApi.supervisionHealth.mockResolvedValue({
      health: {
        planIssueId: "plan-1",
        overdue: true,
        agents: [
          {
            agentId: "agent-9",
            agentName: "Backend Bot",
            issueId: "issue-2",
            health: "stuck",
            severity: "warning",
            lastOutputAt: null,
            detail: "No output for 45m",
          },
        ],
      },
    });
    mockPlansApi.takeAction.mockResolvedValue({ note: {}, actionTaken: "rewake" });
    mockPlansApi.monitorNow.mockResolvedValue({ woken: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the agent health panel and re-wakes an agent on click", async () => {
    render("active");
    await flushReact();

    expect(document.body.textContent).toContain("Backend Bot");
    expect(document.body.textContent).toContain("Stuck");
    expect(document.body.textContent).toContain("Overdue");

    const rewake = buttonByText("Re-wake");
    expect(rewake).toBeTruthy();
    rewake!.click();
    await flushReact();

    expect(mockPlansApi.takeAction).toHaveBeenCalledWith("plan-1", {
      action: "rewake",
      targetAgentId: "agent-9",
    });
  });

  it("stop & escalate prompts for a reason and dispatches it", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("plan is blocked");
    render("active");
    await flushReact();

    buttonByText("Stop & escalate")!.click();
    await flushReact();

    expect(promptSpy).toHaveBeenCalled();
    expect(mockPlansApi.takeAction).toHaveBeenCalledWith("plan-1", {
      action: "stop_escalate",
      reason: "plan is blocked",
    });
    promptSpy.mockRestore();
  });

  it("does not dispatch stop & escalate when the prompt is cancelled", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    render("active");
    await flushReact();

    buttonByText("Stop & escalate")!.click();
    await flushReact();

    expect(mockPlansApi.takeAction).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("hides health panel and actions for a non-active plan", async () => {
    render("stopped");
    await flushReact();

    expect(buttonByText("Re-wake")).toBeUndefined();
    expect(buttonByText("Stop & escalate")).toBeUndefined();
    expect(buttonByText("Monitor now")).toBeUndefined();
    // Health endpoint is not queried for inactive plans.
    expect(mockPlansApi.supervisionHealth).not.toHaveBeenCalled();
  });
});
