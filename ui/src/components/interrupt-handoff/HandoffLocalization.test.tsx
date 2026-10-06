// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { computeComposerHandoffPreview, computePauseAffectsSummary, describeReassignInterrupt } from "@/lib/interrupt-handoff";
import { AssigneeRunningBanner, ComposerHandoffPreviewRow, ComposerMentionCoach, HandoffWakeRow, InterruptAssignConfirm, PauseAffectsSummaryView, RunStatusBadge } from "./InterruptHandoffViews";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const resolvers = { agentMap: new Map([["agent-raw", { name: "RAW_AGENT" }]]), resolveUserLabel: () => "RAW_USER", currentUserId: "user-raw" };
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  await i18n.changeLanguage("en");
});
async function mount(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(node));
}
async function locale(lang: "en" | "ru") { await act(async () => { await i18n.changeLanguage(lang); }); }

describe("Handoff localization", () => {
  it.each([
    ["agent:agent-raw", true, "Прервать текущий запуск и передать задачу:"],
    ["agent:agent-raw", false, "Запустить агента:"],
    ["user:user-raw", true, "Передать задачу:"],
    ["__none__", true, "Снять ответственного"],
  ])("updates a stored preview for %s without changing assignment intent", async (target, active, expected) => {
    const preview = computeComposerHandoffPreview({ reassignTarget: target, currentAssigneeValue: "agent:other-raw", hasActiveRun: active, bodyHasAgentMention: false });
    const before = JSON.stringify(preview);
    await mount(<ComposerHandoffPreviewRow preview={preview} resolvers={resolvers} />);
    await locale("ru");
    expect(host?.textContent).toContain(expected);
    if (preview.chip) expect(host?.textContent).toContain(preview.chip.kind === "agent" ? "RAW_AGENT" : "RAW_USER (вы)");
    if (target === "user:user-raw" || target === "__none__") expect(host?.textContent).toContain("агенты не получат уведомление");
    expect(host?.querySelector('[data-testid="composer-handoff-preview"]')?.getAttribute("data-kind")).toBe(preview.kind);
    await locale("en");
    expect(host?.textContent).toContain(preview.text);
    expect(JSON.stringify(preview)).toBe(before);
  });

  it("keeps wake and interruption distinctions visible when the locale changes", async () => {
    await mount(<><HandoffWakeRow to={{ agentId: "agent-raw", userId: null }} resolvers={resolvers} interruptedRunAttached /><HandoffWakeRow to={{ agentId: null, userId: "user-raw" }} resolvers={resolvers} /><RunStatusBadge status="cancelled" operatorInterrupted /><RunStatusBadge status="cancelled" /></>);
    await locale("ru");
    expect(host?.textContent).toContain("в очереди; агент — RAW_AGENT (связан с прерванным запуском)");
    expect(host?.textContent).toContain("не создан — задача передана пользователю панели управления");
    expect(host?.querySelector('[data-interrupted="true"]')?.textContent).toContain("прерван комментарием руководства");
    expect(host?.querySelector('[data-interrupted="false"]')?.textContent).toBe("отменён");
    expect(host?.querySelector('[data-interrupted="true"]')?.className).toContain("amber");
  });

  it("translates mention coaching without inserting or dismissing automatically", async () => {
    const onInsert = vi.fn(), onDismiss = vi.fn();
    const candidate = { agentId: "agent-raw", matchedText: "RAW_AGENT" };
    await mount(<ComposerMentionCoach candidate={candidate} agentDisplayName="RAW_AGENT" onInsert={onInsert} onDismiss={onDismiss} />);
    await locale("ru");
    expect(host?.textContent).toContain("@RAW_AGENT");
    expect(host?.textContent).toContain("Обычный текст не уведомляет агента");
    expect(onInsert).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => host?.querySelector<HTMLButtonElement>('button[aria-label="Вставить упоминание в комментарий: RAW_AGENT"]')?.click());
    expect(onInsert).toHaveBeenCalledTimes(1);
    await act(async () => host?.querySelector<HTMLButtonElement>('button[aria-label="Закрыть подсказку"]')?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(candidate).toEqual({ agentId: "agent-raw", matchedText: "RAW_AGENT" });
  });

  it("translates stored interrupt copy and pause summaries while retaining counters and callbacks", async () => {
    const copy = describeReassignInterrupt({ runningAgentName: "RAW_AGENT" });
    const summary = computePauseAffectsSummary([{ assigneeAgentId: "agent-raw", assigneeUserId: null, activeRun: { status: "running" } }, { assigneeAgentId: null, assigneeUserId: "user-raw", activeRun: null }]);
    const before = JSON.stringify({ copy, summary });
    const onConfirm = vi.fn(), onCancel = vi.fn();
    await mount(<><AssigneeRunningBanner copy={copy} /><InterruptAssignConfirm copy={copy} to={{ agentId: null, userId: "user-raw" }} resolvers={resolvers} onConfirm={onConfirm} onCancel={onCancel} /><PauseAffectsSummaryView summary={summary} /></>);
    await locale("ru");
    expect(host?.textContent).toContain("Смена ответственного прервёт этот запуск");
    expect(host?.textContent).toContain("Прервать текущий запуск?");
    expect(host?.textContent).toContain("Что затронет приостановка");
    expect(host?.querySelector('[data-bucket="live_runs"]')?.textContent).toContain("после возобновления снова встанут в очередь");
    expect(host?.querySelector('[data-bucket="human_owned"]')?.textContent).toContain("не отправит ему уведомление");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(JSON.stringify({ copy, summary })).toBe(before);
    await act(async () => host?.querySelector<HTMLButtonElement>('[data-testid="interrupt-assign-confirm-action"]')?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("preserves unknown custom preview and confirmation copy", async () => {
    await mount(<><ComposerHandoffPreviewRow preview={{ kind: "wake_agent", tone: "neutral", text: "CUSTOM_TEXT", suffix: "CUSTOM_SUFFIX" }} resolvers={resolvers} /><AssigneeRunningBanner copy={{ banner: "CUSTOM_WARNING", confirmTitle: "CUSTOM_TITLE", confirmAction: "CUSTOM_ACTION", cancelAction: "CUSTOM_CANCEL" }} /></>);
    await locale("ru");
    expect(host?.textContent).toContain("CUSTOM_TEXT");
    expect(host?.textContent).toContain("CUSTOM_SUFFIX");
    expect(host?.textContent).toContain("CUSTOM_WARNING");
  });
});
