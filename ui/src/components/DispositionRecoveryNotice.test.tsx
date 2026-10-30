// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispositionRecoveryNotice, DispositionRecoveryProvider, dispositionRetryUnavailableReason, readDispositionRecoverySnapshot, type DispositionRecoveryContextValue, type DispositionRecoverySnapshot } from "./DispositionRecoveryNotice";
import { TaskChatSystemNotice } from "./task-chat/TaskChatSystemNotice";

const snapshot: DispositionRecoverySnapshot = { kind: "disposition_repair_escalated", actionId: "action-1", attemptCount: 2, maxAttempts: 2, reason: "unchanged_source_state_exhausted", assigneeAgentId: "agent-1" };
function context(): DispositionRecoveryContextValue {
  return {
    issue: { executionRunId: null, checkoutRunId: null, status: "blocked", assigneeAgentId: "agent-1", activeRecoveryAction: { id: "action-1", status: "active", kind: "deliberate_wait_without_target", ownerType: "board", returnOwnerAgentId: "agent-1", wakePolicy: { type: "board_escalation" } } as NonNullable<DispositionRecoveryContextValue["issue"]["activeRecoveryAction"]> },
    agentMap: new Map([["agent-1", { name: "Alex", status: "idle" }]]),
    onRetry: vi.fn(async () => {}),
  };
}

describe("disposition recovery notice", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(value = context(), data = snapshot) {
    await act(async () => root.render(<DispositionRecoveryProvider value={value}><DispositionRecoveryNotice snapshot={data} createdAt={new Date().toISOString()} /></DispositionRecoveryProvider>));
  }
  const button = (name: string) => Array.from(container.querySelectorAll("button")).find(b => b.textContent === name)!;
  it("shows the explanation and action without exposing technical detail until expanded", async () => {
    await render();
    expect(container.textContent).toContain("Agent needs attention");
    expect(container.textContent).toContain("Two automatic attempts");
    expect(button("Retry agent").disabled).toBe(false);
    expect(container.textContent).not.toContain(snapshot.reason);
    await act(async () => button("View details").click());
    expect(button("Hide details").getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(`#${CSS.escape(button("Hide details").getAttribute("aria-controls")!)}`)).not.toBeNull();
    expect(container.textContent).toContain("2 of 2");
    expect(container.textContent).toContain("Alex");
    expect(container.textContent).toContain(snapshot.reason);
  });
  it("awaits the real request, blocks repeated clicks, then acknowledges the result", async () => {
    let finish!: () => void;
    const value = context(); value.onRetry = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await render(value);
    await act(async () => { button("Retry agent").click(); button("Retry agent")?.click(); });
    expect(value.onRetry).toHaveBeenCalledExactlyOnceWith("action-1");
    expect(button("Requesting retry…").disabled).toBe(true);
    await act(async () => finish());
    expect(container.textContent).toContain("Retry requested");
    expect(container.textContent).toContain("returned to To do for Alex");
    expect(button("Retry agent")).toBeUndefined();
  });
  it("shows a rejected request inline and allows another attempt without promising that nothing ran", async () => {
    const value = context(); value.onRetry = vi.fn().mockRejectedValueOnce(new Error("The company spending limit was reached.")).mockResolvedValueOnce(undefined);
    await render(value);
    await act(async () => button("Retry agent").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("spending limit");
    expect(container.textContent).not.toContain("No new run was started");
    expect(button("Retry agent").disabled).toBe(false);
    await act(async () => button("Retry agent").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Retry requested");
  });
  it("shows the current gate next to a disabled retry action", async () => {
    const value = context(); value.unavailableReason = "The task is paused.";
    await render(value);
    const retry = button("Retry agent");
    expect(retry.disabled).toBe(true);
    expect(document.getElementById(retry.getAttribute("aria-describedby")!)?.textContent).toContain("task is paused");
    await act(async () => retry.click()); expect(value.onRetry).not.toHaveBeenCalled();
  });
  it("retires an old notice when a different recovery action replaces it", async () => {
    const value = context(); await render(value);
    value.issue.activeRecoveryAction = { ...value.issue.activeRecoveryAction!, id: "action-2" };
    await render(value);
    expect(container.textContent).toContain("Agent needed attention");
    expect(container.textContent).toContain("no longer active");
    expect(button("Retry agent")).toBeUndefined();
  });
  it.each(["owner_not_invokable", "owner_budget_blocked"])("does not invent exhausted attempts for %s", async reason => {
    await render(context(), { ...snapshot, attemptCount: 0, reason });
    expect(container.textContent).not.toContain("attempts to resolve this failed");
    await act(async () => button("View details").click()); expect(container.textContent).toContain("0 of 2");
  });
  it("uses typed metadata regardless of prose and rejects prose-only lookalikes", async () => {
    const value = context();
    const item = { id: "notice", kind: "message" as const, author: "system" as const, text: "完全に異なる文章", metadata: { version: 1 as const, sections: [], recovery: snapshot } };
    await act(async () => root.render(<DispositionRecoveryProvider value={value}><TaskChatSystemNotice item={item} /></DispositionRecoveryProvider>));
    expect(button("Retry agent").disabled).toBe(false);
    await act(async () => root.render(<DispositionRecoveryProvider value={value}><TaskChatSystemNotice item={{ ...item, text: "Recovery: disposition repair escalated — source owner preserved", metadata: null }} /></DispositionRecoveryProvider>));
    expect(container.querySelector('[data-testid="disposition-recovery-notice"]')).toBeNull();
    await act(async () => root.render(<DispositionRecoveryProvider value={value}><TaskChatSystemNotice item={{ ...item, author: "agent" }} /></DispositionRecoveryProvider>));
    expect(container.querySelector('[data-testid="disposition-recovery-notice"]')).toBeNull();
  });
});

describe("disposition retry affordance gates", () => {
  it("allows the current exhausted action only", () => expect(dispositionRetryUnavailableReason(snapshot, context())).toBeNull());
  it.each(["done", "cancelled", "backlog", "todo", "in_progress", "in_review"] as const)("does not reopen %s", status => {
    const value = context(); value.issue.status = status;
    expect(dispositionRetryUnavailableReason(snapshot, value)).not.toBeNull();
  });
  it.each(["assignee", "returnOwner", "action", "run", "checkout", "pausedAgent", "terminatedAgent", "approval", "blocker", "pause", "automaticRepair", "interaction"])("blocks %s", gate => {
    const value = context();
    if (gate === "assignee") value.issue.assigneeAgentId = "someone-else";
    if (gate === "returnOwner") value.issue.activeRecoveryAction!.returnOwnerAgentId = "someone-else";
    if (gate === "action") value.issue.activeRecoveryAction = null;
    if (gate === "run") value.issue.executionRunId = "running";
    if (gate === "checkout") value.issue.checkoutRunId = "checked-out";
    if (gate === "pausedAgent" || gate === "terminatedAgent") value.agentMap = new Map([["agent-1", { name: "Alex", status: gate === "pausedAgent" ? "paused" : "terminated" }]]);
    if (gate === "approval") value.issue.executionState = { status: "pending" } as NonNullable<DispositionRecoveryContextValue["issue"]["executionState"]>;
    if (gate === "blocker") value.issue.blockedBy = [{ status: "in_progress" }] as DispositionRecoveryContextValue["issue"]["blockedBy"];
    if (gate === "pause") value.unavailableReason = "Paused";
    if (gate === "interaction") value.hasPendingInteraction = true;
    if (gate === "automaticRepair") value.issue.activeRecoveryAction!.ownerType = "agent";
    expect(dispositionRetryUnavailableReason(snapshot, value)).not.toBeNull();
  });
});


describe("older structured recovery notices", () => {
  it("uses exact action/run references and evidence without reading English labels or prose", () => {
    const action = { ...context().issue.activeRecoveryAction!, evidence: { latestRunId: "run-1", terminalReason: snapshot.reason, sourceAttemptCount: 2, sourceMaxAttempts: 2 } };
    const metadata = { version: 1 as const, sourceRunId: "run-1", sections: [{ rows: [{ type: "key_value" as const, label: "別のラベル", value: "action-1" }] }] };
    expect(readDispositionRecoverySnapshot(metadata, action)).toEqual(snapshot);
    expect(readDispositionRecoverySnapshot({ ...metadata, sourceRunId: "older-run" }, action)).toBeNull();
    expect(readDispositionRecoverySnapshot({ ...metadata, sections: [] }, action)).toBeNull();
    expect(readDispositionRecoverySnapshot(metadata, { ...action, id: "action-2" })).toBeNull();
    expect(readDispositionRecoverySnapshot(metadata, { ...action, evidence: {} })).toBeNull();
    expect(readDispositionRecoverySnapshot(metadata, null)).toBeNull();
  });
});
