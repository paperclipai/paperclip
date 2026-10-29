// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerGoalProjection } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { RunnerGoalWidget, useRunnerGoalControl } from "./RunnerGoalWidget";

vi.mock("@/api/issues", () => ({ issuesApi: { getRunnerGoal: vi.fn(), actOnRunnerGoal: vi.fn() } }));
vi.mock("@/context/LiveUpdatesProvider", () => ({ useCompanyLiveEvent: vi.fn() }));

const projection: RunnerGoalProjection = {
  issueId: "issue-goal", agentId: "agent-goal", adapterType: "paperclip_runner", sessionId: "session-goal",
  capability: { availability: "available", verified: true, actions: ["set", "pause", "resume", "clear"], autonomousUpdates: true,
    persistentAcrossResume: true, maxObjectiveChars: 4_000, tokenBudgetControl: true, usageReporting: true },
  goal: { objective: "Original objective", status: "active", tokenBudget: null, tokensUsed: 20, elapsedSeconds: 2,
    iterations: 1, lastReason: null, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:02Z",
    completedAt: null, workingNow: false },
  workingNow: false, activeRunId: null, pendingAction: null, revision: 7, observedAt: "2026-09-08T00:00:02Z",
};

function Harness({ agentId = "agent-goal" }: { agentId?: string }) {
  const control = useRunnerGoalControl("issue-goal", agentId);
  const [commandError, setCommandError] = useState<string | null>(null);
  return <>
    <button onClick={() => void control.executeComposerCommand({ action: "create", objective: "Replacement objective" }).catch((error) => setCommandError(error.message))}>Request replacement</button>
    <button onClick={() => void control.executeComposerCommand({ action: "focus" }).catch((error) => setCommandError(error.message))}>Focus goal</button>
    {commandError ? <p role="alert">{commandError}</p> : null}
    <RunnerGoalWidget control={control} />
  </>;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function button(name: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    (node.getAttribute("aria-label") ?? node.textContent?.trim()) === name);
  if (!element) throw new Error(`Missing button: ${name}`);
  return element;
}
async function click(name: string) { await act(async () => { button(name).click(); }); }
async function objective(value: string) {
  await act(async () => {
    const field = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(agentId = "agent-goal") {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Harness agentId={agentId} /></QueryClientProvider>);
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.issues.runnerGoal("issue-goal", "agent-goal"), projection);
  vi.mocked(issuesApi.getRunnerGoal).mockResolvedValue(projection);
  vi.mocked(issuesApi.actOnRunnerGoal).mockResolvedValue({ projection, accepted: true } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("session goal dialogs", () => {
  it("hides the widget after an expanded goal is cleared", async () => {
    await click("Focus goal");
    vi.mocked(issuesApi.actOnRunnerGoal).mockResolvedValue({
      accepted: true, projection: { ...projection, goal: null, revision: 8 },
    } as never);
    await click("Clear goal");
    await vi.waitFor(() => expect(document.querySelector('[data-testid="runner-goal-widget"]')).toBeNull());
  });

  it("does not show an empty card when /goal has no current goal to focus", async () => {
    await act(async () => {
      client.setQueryData(queryKeys.issues.runnerGoal("issue-goal", "agent-goal"), { ...projection, goal: null });
    });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="runner-goal-widget"]')).toBeNull());
    await click("Focus goal");
    expect(document.querySelector('[data-testid="runner-goal-widget"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Add an objective after /goal");
    expect(issuesApi.actOnRunnerGoal).not.toHaveBeenCalled();
  });

  it("keeps a pending goal action visible without a goal snapshot", async () => {
    await act(async () => {
      client.setQueryData(queryKeys.issues.runnerGoal("issue-goal", "agent-goal"), {
        ...projection, goal: null, pendingAction: "starting",
      });
    });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="runner-goal-widget"]')?.textContent).toContain("Starting"));
  });

  it("shows action errors without leaving behind an empty informational card", async () => {
    await act(async () => {
      client.setQueryData(queryKeys.issues.runnerGoal("issue-goal", "agent-goal"), { ...projection, goal: null });
    });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="runner-goal-widget"]')).toBeNull());
    vi.mocked(issuesApi.actOnRunnerGoal).mockRejectedValue(new Error("Session is unavailable."));
    await click("Request replacement");
    await vi.waitFor(() => expect(document.querySelector('[data-testid="runner-goal-widget"]')?.textContent).toContain("Session is unavailable."));
  });

  it("opens a prefilled in-app editor and saves with the reviewed revision", async () => {
    await click("Edit goal");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Edit session goal");
    expect(document.querySelector("textarea")?.value).toBe("Original objective");
    await objective("Revised objective");
    await click("Save goal");
    expect(issuesApi.actOnRunnerGoal).toHaveBeenCalledWith("issue-goal", expect.objectContaining({
      action: "edit", objective: "Revised objective", expectedRevision: 7, agentId: "agent-goal",
    }));
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  });

  it("requires explicit replacement confirmation and lets cancellation preserve the goal", async () => {
    await click("Request replacement");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Replace session goal?");
    expect(document.querySelector("textarea")?.value).toBe("Replacement objective");
    expect(issuesApi.actOnRunnerGoal).not.toHaveBeenCalled();
    await click("Cancel");
    expect(issuesApi.actOnRunnerGoal).not.toHaveBeenCalled();
    await click("Request replacement");
    await click("Replace goal");
    expect(issuesApi.actOnRunnerGoal).toHaveBeenCalledWith("issue-goal", expect.objectContaining({
      action: "replace", objective: "Replacement objective", confirmReplace: true, expectedRevision: 7,
    }));
  });

  it("rejects whitespace and retains edited text with a visible server error", async () => {
    vi.mocked(issuesApi.actOnRunnerGoal).mockRejectedValue(new Error("Goal changed; reopen the editor to review the latest goal."));
    await click("Edit goal");
    await objective("   ");
    expect(button("Save goal").disabled).toBe(true);
    await objective("Keep my draft");
    await click("Save goal");
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Goal changed"));
    expect(document.querySelector("textarea")?.value).toBe("Keep my draft");
    await click("Cancel");
    await click("Edit goal");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Goal changed");
    await click("Cancel");
    await click("Request replacement");
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Goal changed");
  });

  it("dismisses an editor when the selected agent changes", async () => {
    await click("Edit goal");
    await render("another-agent");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(issuesApi.actOnRunnerGoal).not.toHaveBeenCalled();
  });
});
