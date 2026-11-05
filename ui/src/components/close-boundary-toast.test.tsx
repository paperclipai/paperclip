// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ToastProvider, useToastActions, useToastState, type ToastInput, type ToastItem } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";
import { MutationObserver } from "@tanstack/react-query";
import { createAppQueryClient } from "../lib/query-client";
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
vi.stubGlobal("cancelAnimationFrame", clearTimeout);
let root: ReturnType<typeof createRoot>;
afterEach(async () => { await act(async () => root?.unmount()); vi.useRealTimers(); await i18n.changeLanguage("en"); });
it("resolves held opt-in copy on en↔zh renders without changing storage, identity, dedupe, timers or actions", async () => {
  await i18n.changeLanguage("en"); vi.useFakeTimers();
  const container = document.createElement("div"); root = createRoot(container);
  let push!: (input: ToastInput) => string | null; let stored!: ToastItem[];
  function Probe() { push = useToastActions().pushToast; stored = useToastState(); return <ToastViewport />; }
  await act(async () => root.render(<ToastProvider><Probe /></ToastProvider>));
  const action = vi.fn(); const actor = { type: "user" as const, id: "actor/raw", name: "Alex 原文" };
  const input = { title: "Raw stored title", body: "Raw stored body", ttlMs: 6000, actor, action: { label: "Raw stored action", onClick: action }, presentation: { title: { key: "task-components:traceReRunNotStarted_efabea93" }, body: { key: "deep-ui:paperclip_could_not_start_the_trace_re_run_cbb5c5" }, action: { key: "task-components:reply_c253f451" } } };
  await act(async () => { push(input); });
  const item = stored[0]; const timerSpy = vi.spyOn(window, "setTimeout");
  expect(container.textContent).toContain("Trace re-run not started");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).not.toContain("Trace re-run not started");
  expect(container.textContent).not.toContain("Raw stored body");
  expect(stored[0]).toBe(item); expect(item.title).toBe(input.title); expect(item.body).toBe(input.body);
  expect(item.actor).toBe(actor); expect(item.action).toBe(input.action); expect(timerSpy.mock.calls.filter(([, delay]) => delay === 6000)).toHaveLength(0);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(container.textContent).toContain("Trace re-run not started");
  expect(action).not.toHaveBeenCalled();
  await act(async () => { expect(push(input)).toBeNull(); }); expect(stored).toHaveLength(1);
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === "Reply")!;
  await act(async () => button.click()); expect(action).toHaveBeenCalledTimes(1); expect(stored).toHaveLength(0);
});
it("renders an already-shown opted-in mutation error on locale switches without reexecuting the mutation", async () => {
  await i18n.changeLanguage("en");
  const container = document.createElement("div"); root = createRoot(container);
  let push!: (input: ToastInput) => string | null; let stored!: ToastItem[];
  function Probe() { push = useToastActions().pushToast; stored = useToastState(); return <ToastViewport />; }
  await act(async () => root.render(<ToastProvider><Probe /></ToastProvider>));
  const error = new Error("Upload did not return a file URL"); const original = Object.getOwnPropertyDescriptors(error);
  const call = vi.fn().mockRejectedValue(error);
  const client = createAppQueryClient({ connectivity: { getSnapshot: () => ({ status: "online" } as never), reportError: () => {} }, notifyMutationError: toast => { push({ ...toast, tone: "error" }); } });
  const mutation = new MutationObserver(client, { mutationFn: call, meta: { errorToast: true } });
  await act(async () => { await mutation.mutate(undefined).catch(() => {}); });
  const item = stored[0]; expect(container.textContent).toContain("Something went wrong");
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).not.toContain("Something went wrong"); expect(container.textContent).toContain(error.message);
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(container.textContent).toContain("Something went wrong"); expect(call).toHaveBeenCalledTimes(1); expect(stored).toHaveLength(1); expect(stored[0]).toBe(item);
  expect(Object.getOwnPropertyDescriptors(error)).toEqual(original); expect(mutation.getCurrentResult().error).toBe(error); client.clear();
});
it("leaves existing string-only diagnostics verbatim even when they equal UI copy and expires on the original TTL", async () => {
  await i18n.changeLanguage("en"); vi.useFakeTimers();
  const container = document.createElement("div"); root = createRoot(container); let push!: (input: ToastInput) => string | null;
  function Probe() { push = useToastActions().pushToast; return <ToastViewport />; }
  await act(async () => root.render(<ToastProvider><Probe /></ToastProvider>));
  await act(async () => { push({ title: "Trace re-run not started", body: "Upload did not return a file URL", ttlMs: 2000 }); vi.advanceTimersByTime(1000); });
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(container.textContent).toContain("Trace re-run not started"); expect(container.textContent).toContain("Upload did not return a file URL");
  await act(async () => vi.advanceTimersByTime(1000)); expect(container.textContent).toBe("");
});
