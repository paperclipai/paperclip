// @vitest-environment jsdom
import { act, lazy, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DeferredOverlay } from "./DeferredOverlay";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../lib/sentry", () => ({ captureBrowserException: capture }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  capture.mockClear();
});
it("dismisses a failed chunk without replacing the board or its draft", async () => {
  const Failed = lazy(async () => { throw new Error("Chunk download failed"); });
  function Board() {
    const [requested, setRequested] = useState(true);
    return <><textarea defaultValue="Keep my unsent reply" /><DeferredOverlay requested={requested} title="New task" onClose={() => setRequested(false)}><Failed /></DeferredOverlay></>;
  }
  await act(async () => root.render(<Board />));
  const draft = container.querySelector("textarea")!;
  expect(document.body.textContent).toContain("Couldn't open new task");
  const close = [...document.querySelectorAll("button")].find((button) => button.textContent === "Close")!;
  await act(async () => close.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Keep my unsent reply");
  expect(capture).toHaveBeenCalledWith(expect.any(Error));
});
it("removes a pending overlay on navigation and contains a later rejection", async () => {
  let reject!: (error: Error) => void;
  const Pending = lazy(() => new Promise<never>((_, rejectImport) => { reject = rejectImport; }));
  function render(requested: boolean) {
    return <><textarea defaultValue="Saved draft" /><DeferredOverlay requested={requested} title="Setup" onClose={() => {}}><Pending /></DeferredOverlay></>;
  }
  await act(async () => root.render(render(true)));
  expect(document.body.textContent).toContain("Loading setup");
  const draft = container.querySelector("textarea");
  await act(async () => root.render(render(false)));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => reject(new Error("Late chunk failure")));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector("textarea")).toBe(draft);
});
it("allows cancelling an in-flight download", async () => {
  const Pending = lazy(() => new Promise<never>(() => {}));
  function Board() {
    const [requested, setRequested] = useState(true);
    return <DeferredOverlay requested={requested} title="New project" onClose={() => setRequested(false)}><Pending /></DeferredOverlay>;
  }
  await act(async () => root.render(<Board />));
  const cancel = [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
  await act(async () => cancel.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
