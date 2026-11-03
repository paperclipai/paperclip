// @vitest-environment jsdom
import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import type { TranscriptEntry } from "@/adapters";
import { i18n, useTranslation } from "@/i18n";
import { MemoryRouter } from "@/lib/router";
import { ThemeProvider } from "@/context/ThemeContext";
import { pendingRequestCheckboxConfirmationInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { nativeRunEventsToTranscript } from "../transcript/native-run-events";
import { useNativeRunTranscripts } from "../transcript/useNativeRunTranscripts";
import { transcriptToTaskChatItems } from "./transcript-adapter";
import { TaskChatUsageReadout } from "./TaskChatUsageReadout";
import { TaskChatProtocolActivityRow, TaskChatProtocolActivityDetails } from "./TaskChatProtocolActivityRow";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatInteractionCard } from "./TaskChatInteractionCard";
import { taskChatDisplayLabel } from "./task-chat-display";
import type { TaskChatProviderActivityItem, TaskChatUsageItem } from "./task-chat-model";

const eventsMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { events: eventsMock } }));
const RUN = "10000000-0000-4000-8000-000000000001";
const TS = "2026-10-26T12:00:00.000Z";
function event(seq: number, eventType: string, payload: Record<string, unknown>): HeartbeatRunEvent {
  return {
    id: seq, companyId: "company", runId: RUN, agentId: "agent", seq, eventType,
    stream: "system", level: "info", color: null, message: null, createdAt: new Date(TS),
    payload: { prpEvent: {
      schema: "paperclip.prp.event.v1", sourceEventId: `event-${seq}`, sourceSeq: seq,
      sourceInstanceId: "runner-1", sourceKind: "runner", runId: RUN, normalizedSessionId: "session-1",
      eventType, schemaVersion: 1, priority: 1, emittedAt: TS, payload,
    } },
  };
}
const usageText = "Provider-reported session-cumulative usage; a per-run delta was unavailable.";
function usageEvent() {
  return event(3, "usage.reported", {
    runDeltaAvailable: false, runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 },
    cumulative: { inputTokens: 1234, outputTokens: 5, providerCostUsd: 0.02 },
  });
}
function noticeEvent(seq: number, summary?: string) {
  return event(seq, "provider.notice.recorded", {
    schema: "paperclip.provider.notice.v1", noticeId: `notice-${seq}`,
    severity: "info", category: "session", userActionable: true, ...(summary ? { summary } : {}),
  });
}
function Cards({ item }: { item: TaskChatProviderActivityItem }) {
  return <><TaskChatProtocolActivityRow item={item} /><TaskChatProtocolCard item={item} /><TaskChatProtocolActivityDetails item={item} /></>;
}
function CachedProbe() {
  const { transcriptByRun } = useNativeRunTranscripts([{ id: RUN, status: "succeeded", runtimeMode: "native" }]);
  const items = useMemo(() => transcriptToTaskChatItems(transcriptByRun.get(RUN) ?? [], { runId: RUN, running: false }), [transcriptByRun]);
  return <>{items.map(item => item.kind === "usage" ? <TaskChatUsageReadout key={item.id} item={item} />
    : item.kind === "protocol" && item.surface === "provider_activity" ? <Cards key={item.id} item={item} /> : null)}</>;
}
let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  await i18n.changeLanguage("en"); eventsMock.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await i18n.changeLanguage("en"); });
async function locale(value: string) { await act(async () => { await i18n.changeLanguage(value); }); }

it("updates cached native fallbacks without refetching or changing canonical provider events", async () => {
  const events = [noticeEvent(1), usageEvent()];
  const original = JSON.stringify(events);
  const canonical = nativeRunEventsToTranscript(events);
  const serialized = JSON.stringify(canonical);
  eventsMock.mockResolvedValue(events);
  await act(async () => { root.render(<MemoryRouter><ThemeProvider><CachedProbe /></ThemeProvider></MemoryRouter>); });
  expect(container.textContent).toContain(usageText);
  expect(container.textContent).toContain("Provider session total");
  expect(container.textContent).toContain("$0.0200");
  expect(container.textContent).toContain("Provider notice");
  await locale("ru");
  expect(container.textContent).toContain("Суммарный расход ресурсов за сессию по данным провайдера");
  expect(container.textContent).toContain("Уведомление провайдера");
  expect(container.textContent).not.toContain(usageText);
  expect(container.textContent).not.toContain("Provider notice");
  expect(container.textContent).toContain("$0,0200");
  await locale("en");
  expect(container.textContent).toContain(usageText);
  expect(container.textContent).toContain("$0.0200");
  expect(eventsMock).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(events)).toBe(original);
  expect(JSON.stringify(canonical)).toBe(serialized);
  expect(nativeRunEventsToTranscript(events)).toEqual(canonical);
});

it("does not translate identical text supplied by a provider or legacy transcript", async () => {
  const externalNotice = nativeRunEventsToTranscript([noticeEvent(2, "Provider notice")]);
  const externalUsage: TranscriptEntry = { kind: "result", ts: TS, subtype: "paperclip_runner_session_usage", text: usageText, inputTokens: 1234, outputTokens: 5, cachedTokens: 0, costUsd: 0.02, isError: false, errors: [] };
  const items = transcriptToTaskChatItems([...externalNotice, externalUsage], { runId: RUN, running: false });
  const notice = items.find(item => item.kind === "protocol") as TaskChatProviderActivityItem;
  const usage = items.find(item => item.kind === "usage") as TaskChatUsageItem;
  expect(notice.summaryMessage).toBeUndefined(); expect(usage.detailMessage).toBeUndefined();
  await act(async () => root.render(<MemoryRouter><ThemeProvider><Cards item={notice} /><TaskChatUsageReadout item={usage} /></ThemeProvider></MemoryRouter>));
  await locale("ru");
  expect(container.textContent).toContain("Provider notice");
  expect(container.textContent).toContain(usageText);
  expect(usage.detail).toBe(usageText);
  await locale("en");
  expect(container.textContent).toContain(usageText);
});

it("resolves the empty legacy cumulative explanation and existing canonical status labels at render", async () => {
  const items = transcriptToTaskChatItems([{ kind: "result", ts: TS, subtype: "paperclip_runner_session_usage", text: "", inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, isError: false, errors: [] }], { runId: RUN, running: false });
  const item = items.find(item => item.kind === "usage") as TaskChatUsageItem;
  const labels = ["Responding", "Thinking", "Running"];
  function Probe() { useTranslation(); return <><TaskChatUsageReadout item={item} />{labels.map(label => <span key={label}>{taskChatDisplayLabel(label)}</span>)}</>; }
  await act(async () => root.render(<Probe />));
  const english = container.textContent;
  await locale("ru");
  expect(container.textContent).toContain("В эти суммарные значения могут входить данные");
  for (const label of labels) expect(container.textContent).not.toContain(label);
  await locale("en"); expect(container.textContent).toBe(english);
  expect(labels).toEqual(["Responding", "Thinking", "Running"]);
  expect(item.label).toBe("Provider session total");
});

it("updates pending-request fallback copy while preserving literal titles, summaries and request IDs", async () => {
  const onReview = vi.fn();
  const base = pendingRequestCheckboxConfirmationInteraction;
  const fallback = { ...base, id: "fallback-request", title: null, summary: "Raw Review request summary" };
  const raw = { ...base, id: "raw-request", title: "Review request", summary: "Raw Review request summary" };
  await act(async () => root.render(<><TaskChatInteractionCard item={{ kind: "interaction", id: "fallback", interaction: fallback }} showPendingRequest onReviewRequest={onReview} /><TaskChatInteractionCard item={{ kind: "interaction", id: "raw", interaction: raw }} showPendingRequest onReviewRequest={onReview} /></>));
  const fallbackButton = container.querySelector<HTMLButtonElement>("#interaction-fallback-request")!;
  const rawButton = container.querySelector<HTMLButtonElement>("#interaction-raw-request")!;
  expect(fallbackButton.textContent).toContain("Review request");
  await locale("ru");
  expect(fallbackButton.textContent).toContain("Запрос на проверку");
  expect(rawButton.textContent).toContain("Review request");
  expect(rawButton.getAttribute("aria-label")).toBe("Открыть запрос: Review request");
  expect(container.textContent).toContain("Raw Review request summary");
  expect(onReview).not.toHaveBeenCalled();
  await act(async () => fallbackButton.click());
  expect(onReview).toHaveBeenCalledExactlyOnceWith("fallback-request");
  await locale("en");
  expect(fallbackButton.getAttribute("aria-label")).toBe("Open request: Review request");
  expect(onReview).toHaveBeenCalledTimes(1);
});
