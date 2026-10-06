// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispositionRecoveryNotice, DispositionRecoveryProvider, dispositionRetryUnavailableReason, readDispositionRecoverySnapshot, type DispositionRecoveryContextValue, type DispositionRecoverySnapshot } from "./DispositionRecoveryNotice";
import { TaskChatSystemNotice } from "./task-chat/TaskChatSystemNotice";
import { i18n } from "@/i18n";

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
  beforeEach(async () => { await i18n.changeLanguage("en"); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); await i18n.changeLanguage("en"); });
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

  it.each([
    [0, "0 автоматических попыток"], [1, "1 автоматическая попытка"],
    [2, "2 автоматические попытки"], [5, "5 автоматических попыток"],
    [11, "11 автоматических попыток"], [21, "21 автоматическая попытка"],
    [22, "22 автоматические попытки"], [25, "25 автоматических попыток"],
    [101, "101 автоматическая попытка"],
  ])("uses Russian attempt forms for %s without changing counts", async (count, expected) => {
    await i18n.changeLanguage("ru");
    await render(context(), { ...snapshot, attemptCount: Number(count), maxAttempts: 101 });
    expect(container.textContent).toContain(expected);
    await act(async () => button("Посмотреть подробности").click());
    expect(container.textContent).toContain(`${count} из 101`);
    expect(container.textContent).toContain(snapshot.reason);
  });

  it.each([[1, "1 automatic attempt"], [2, "Two automatic attempts"], [5, "5 automatic attempts"]])("preserves exact English attempt wording for %s", async (count, expected) => {
    await render(context(), { ...snapshot, attemptCount: Number(count) });
    expect(container.textContent).toContain(`${expected} to resolve this failed.`);
  });

  it("updates expanded copy and gate reasons on locale changes without changing raw names or enabling retry", async () => {
    const value = context();
    value.agentMap = new Map([["agent-1", { name: "Skill / {{raw}}", status: "paused" }]]);
    await render(value);
    await act(async () => button("View details").click());
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Агенту требуется внимание");
    expect(container.textContent).toContain("Работа назначенного агента приостановлена");
    expect(button("Повторить запуск агента").disabled).toBe(true);
    expect(button("Скрыть подробности").getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Skill / {{raw}}");
    expect(container.textContent).toContain(snapshot.reason);
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(button("Retry agent").disabled).toBe(true);
    expect(button("Hide details").getAttribute("aria-expanded")).toBe("true");
    expect(value.onRetry).not.toHaveBeenCalled();
  });

  it("preserves server diagnostics and raw assignee names in Russian retry states", async () => {
    const value = context();
    value.agentMap = new Map([["agent-1", { name: "Alex / {{raw}}", status: "idle" }]]);
    value.onRetry = vi.fn().mockRejectedValueOnce(new Error("API diagnostic: {{raw}} <denied>")).mockResolvedValueOnce(undefined);
    await i18n.changeLanguage("ru");
    await render(value);
    await act(async () => button("Повторить запуск агента").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Не удалось подтвердить повторную попытку. API diagnostic: {{raw}} <denied>");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t confirm the retry. API diagnostic: {{raw}} <denied>");
    await act(async () => button("Retry agent").click());
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Задача возвращена в статус «К выполнению». Агент: Alex / {{raw}}.");
    expect(value.onRetry).toHaveBeenNthCalledWith(2, "action-1");
  });

  it("translates the fallback retry error after a language change", async () => {
    const value = context(); value.onRetry = vi.fn().mockRejectedValue(null);
    await render(value);
    await act(async () => button("Retry agent").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Refresh the task");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Обновите задачу");
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
