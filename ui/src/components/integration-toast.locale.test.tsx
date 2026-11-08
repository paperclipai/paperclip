// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, MutationObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { i18n, t } from "@/i18n";
import { ToastProvider, useToastActions, useToastState, type ToastInput, type ToastItem } from "../context/ToastContext";
import { __liveUpdatesTestUtils as live } from "../context/LiveUpdatesProvider";
import { ToastViewport } from "./ToastViewport";
import { MemoryRouter } from "@/lib/router";
import { useCopyToast } from "../lib/use-copy-action";
import { localizeUiError } from "../lib/localized-ui-error";
import { createAppQueryClient } from "../lib/query-client";
import { copyTextToClipboard } from "../lib/clipboard";
vi.mock("@/lib/router", async () => await import("react-router-dom"));
vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal("cancelAnimationFrame", clearTimeout);
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let host: HTMLDivElement;
let push: (input: ToastInput) => string | null;
let stored: ToastItem[];
let copy: ReturnType<typeof useCopyToast>;
async function mount() {
  await i18n.changeLanguage("en"); vi.clearAllMocks(); vi.useFakeTimers(); client = new QueryClient();
  host = document.createElement("div"); root = createRoot(host);
  function Probe() { push = useToastActions().pushToast; stored = useToastState(); copy = useCopyToast(); return <ToastViewport />; }
  await act(async () => root.render(<MemoryRouter><ToastProvider><Probe /></ToastProvider></MemoryRouter>));
}
afterEach(async () => { await act(async () => root?.unmount()); client?.clear(); vi.useRealTimers(); vi.restoreAllMocks(); await i18n.changeLanguage("en"); });
const self = { userId: null, agentId: null };
const activity = (action: string, details: Record<string, unknown> = {}) => ({ entityType: "issue", entityId: "raw-task", action, actorType: "user", actorId: "board", details });
function joinToast(payload: Record<string, unknown>): ToastInput | null {
  let result: ToastInput | null = null;
  live.handleLiveEvent(client, "c", "/dashboard", { companyId: "c", type: "activity.logged", payload, createdAt: new Date().toISOString() } as never,
    input => { result = input; return "captured"; }, { cooldownHits: new Map(), suppressUntil: 0, observedRunOutcomes: new Set() }, self);
  return result;
}
const cases: [string, () => ToastInput | null][] = [
  ["created fallback actor/task", () => live.buildActivityToast(client, "c", activity("issue.created"), self)],
  ["updated structured changes", () => live.buildActivityToast(client, "c", activity("issue.updated", { status: "in_progress", priority: "high", assigneeAgentId: null, reopened: true, reopenedFrom: "done", title: "Raw title" }), self)],
  ["comment reopened", () => live.buildActivityToast(client, "c", activity("issue.comment_added", { reopened: true, reopenedFrom: "done", bodySnippet: "Raw comment" }), self)],
  ["comment updated", () => live.buildActivityToast(client, "c", activity("issue.comment_added", { updated: true }), self)],
  ["comment added", () => live.buildActivityToast(client, "c", activity("issue.comment_added"), self)],
  ["agent join", () => joinToast({ entityType: "join_request", entityId: "raw-request", action: "join.requested", details: { requestType: "agent" } })],
  ["human join replay", () => joinToast({ entityType: "join_request", entityId: "raw-request", action: "join.request_replayed", details: { requestType: "human" } })],
  ["agent error", () => live.buildAgentStatusToast({ agentId: "raw-agent", status: "error" }, () => null, client, "c")],
  ...["failed", "timed_out", "cancelled"].map(status => [`run ${status}`, () => live.buildRunStatusToast({ agentId: "raw-agent", runId: "raw-run", status, triggerDetail: "Raw trigger" }, () => null)] as [string, () => ToastInput | null]),
  ["chat identity unavailable", () => live.buildRunStatusToast({ agentId: "raw-agent", runId: "raw-run", status: "failed", errorCode: "low_trust_isolation_unavailable", contextSource: "chat:raw" }, () => "System")],
];
it.each(cases)("keeps held %s presentation live without replacing item/action/actor or resetting expiry", async (_name, build) => {
  await mount(); const input = build()!; const originalTitle = input.title; const originalBody = input.body;
  await act(async () => { push(input); });
  const item = stored[0]; const node = host.querySelector("li"); const before = host.textContent; const ttl = item.ttlMs;
  await act(async () => { vi.advanceTimersByTime(1000); });
  const timerSpy = vi.spyOn(window, "setTimeout");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(input.title).not.toBe(originalTitle);
  expect(host.textContent).toContain(input.title);
  if (input.body) expect(host.textContent).toContain(input.body);
  expect(host.textContent).toContain(input.action!.label);
  expect(stored[0]).toBe(item); expect(host.querySelector("li")).toBe(node);
  expect(item.action).toBe(input.action); expect(item.actor).toBe(input.actor);
  expect(item.title).toBe(originalTitle); expect(item.body).toBe(originalBody);
  expect(timerSpy.mock.calls.filter(([, delay]) => delay === ttl)).toHaveLength(0);
  await act(async () => { expect(push(input)).toBeNull(); });
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(host.textContent).toBe(before); expect(stored).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(ttl - 1000); });
  expect(stored).toHaveLength(0);
});
it("preserves raw actor/task/diagnostic collisions, unknown getters and canonical hrefs", async () => {
  await mount();
  const payload = { ...activity("issue.created", { identifier: "RAW-1", title: "Agent run failed" }), actorName: "System" };
  const snapshot = JSON.stringify(payload); const input = live.buildActivityToast(client, "c", payload, self)!;
  await act(async () => { push(input); push({ title: "New agent join request", body: "Agent run failed", actor: { type: "user", id: "raw", name: "Board" } }); });
  const items = [...stored];
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.textContent).toContain("System 创建了 RAW-1"); expect(host.textContent).toContain("Agent run failed"); expect(host.textContent).toContain("New agent join request");
  expect(input.actor?.name).toBe("System"); expect(host.querySelector("a")?.getAttribute("href")).toBe("/issues/RAW-1");
  expect(stored).toEqual(items); expect(JSON.stringify(payload)).toBe(snapshot);
  await act(async () => { push(live.buildRunStatusToast({ runId: "r2", agentId: "a2", status: "failed", error: "Agent run failed" }, () => "Board")!); });
  expect(stored[0].body).toBe("Agent run failed");
  await act(async () => { await i18n.changeLanguage("en"); }); expect(stored[0].body).toBe("Agent run failed");
});
it("does not infer first-party provenance from arbitrary getters or translate raw actor names", async () => {
  await mount();
  const input: ToastInput = { get title() { return t("final-configuration:joinAgent"); }, get body() { return t("final-configuration:joinWaiting"); }, actor: { type: "user", id: "raw", name: "System" }, ttlMs: 5000 };
  await act(async () => { push(input); }); const item = stored[0]; const before = host.textContent;
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(input.title).not.toBe(item.title); expect(host.textContent).toBe(before); expect(item.actor?.name).toBe("System"); expect(item.presentation).toBeUndefined();
  await act(async () => { await i18n.changeLanguage("en"); }); expect(stored[0]).toBe(item);
});
it.each([false, true])("keeps held copy notification live (failed=%s), raw override and clipboard calls stable", async failed => {
  await mount(); vi.mocked(copyTextToClipboard).mockImplementation(async () => { if (failed) throw new Error("raw"); });
  await act(async () => { await copy("Raw clipboard"); });
  const item = stored[0]; const before = host.textContent;
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.textContent).not.toBe(before); expect(stored[0]).toBe(item);
  await act(async () => { await i18n.changeLanguage("en"); }); expect(host.textContent).toBe(before);
  expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
  if (!failed) { await act(async () => { vi.advanceTimersByTime(3500); await copy("Raw clipboard", "Copied"); }); await act(async () => { await i18n.changeLanguage("zh-CN"); }); expect(stored[0].title).toBe("Copied"); expect(host.textContent).toContain("Copied"); }
});
it("renders the same global mutation cause/descriptor across en↔zh without mutation replay or timer reset", async () => {
  await mount(); const cause = localizeUiError(new Error("Upload did not return a file URL"), { key: "final-boundary:missingFileUrl" });
  const original = Object.getOwnPropertyDescriptors(cause); const operation = vi.fn().mockRejectedValue(cause);
  const queryClient = createAppQueryClient({ connectivity: { getSnapshot: () => ({ status: "online" } as never), reportError: () => {} }, notifyMutationError: toast => push({ ...toast, tone: "error" }) });
  const mutation = new MutationObserver(queryClient, { mutationFn: operation, meta: { errorToast: true } });
  await act(async () => { await mutation.mutate(undefined).catch(() => {}); }); const item = stored[0];
  await act(async () => { vi.advanceTimersByTime(1000); await i18n.changeLanguage("zh-CN"); });
  expect(host.textContent).toContain("上传未返回文件 URL"); expect(stored[0]).toBe(item);
  await act(async () => { await i18n.changeLanguage("en"); }); expect(host.textContent).toContain(cause.message);
  expect(operation).toHaveBeenCalledTimes(1); expect(mutation.getCurrentResult().error).toBe(cause); expect(Object.getOwnPropertyDescriptors(cause)).toEqual(original);
  await act(async () => { vi.advanceTimersByTime(item.ttlMs - 1000); }); expect(stored).toHaveLength(0); queryClient.clear();
});
