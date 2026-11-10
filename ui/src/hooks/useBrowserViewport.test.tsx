// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserPaneSize, useBrowserViewport } from "./useBrowserViewport";
import { browserUseApi } from "@/api/browser-use";
import type { BrowserUseViewportState } from "@paperclipai/shared";

vi.mock("@/api/browser-use", () => ({
  browserUseApi: { resize: vi.fn(), releaseViewport: vi.fn(async () => ({})) },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let result: ReturnType<typeof useBrowserViewport>;
let root: Root, host: HTMLDivElement;
let size = { width: 600, height: 870 };
let observe: () => void;
let hidden = false;
function Harness({ active = true }: { active?: boolean }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  result = useBrowserViewport({
    issueId: "task",
    browserId: "browser",
    enabled: true,
    active,
    frameRef,
  });
  return <iframe ref={frameRef} title="test viewer" />;
}
async function tick(ms = 250) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  hidden = false;
  size = { width: 600, height: 870 };
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observe = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLIFrameElement.prototype, "getClientRects").mockImplementation(
    () => [size] as any,
  );
  vi.spyOn(
    HTMLIFrameElement.prototype,
    "getBoundingClientRect",
  ).mockImplementation(() => size as DOMRect);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    getPropertyValue: () => "70",
  } as any);
  vi.mocked(browserUseApi.resize).mockImplementation(
    async (_issue, _browser, request) => ({
      preset: request.preset,
      ...(request.preset === "fit"
        ? { width: request.width, height: request.height }
        : {}),
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Fit to pane", () => {
  it("debounces actual content dimensions, ignores jitter, and renews an unchanged lease", async () => {
    await tick(200);
    size = { width: 510, height: 770 };
    await act(async () => observe());
    await tick(249);
    expect(browserUseApi.resize).not.toHaveBeenCalled();
    await tick(1);
    expect(browserUseApi.resize).toHaveBeenLastCalledWith(
      "task",
      "browser",
      expect.objectContaining({ preset: "fit", width: 510, height: 700 }),
    );
    size.width = 510.5;
    await act(async () => observe());
    await tick();
    expect(browserUseApi.resize).toHaveBeenCalledTimes(1);
    await tick(8000);
    expect(browserUseApi.resize).toHaveBeenCalledTimes(2);
  });
  it("serializes requests and coalesces rapid changes to the newest dimensions", async () => {
    let finish!: (value: BrowserUseViewportState) => void;
    vi.mocked(browserUseApi.resize).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await tick();
    size.width = 700;
    await act(async () => observe());
    await tick();
    size.width = 800;
    await act(async () => observe());
    await tick();
    expect(browserUseApi.resize).toHaveBeenCalledTimes(1);
    await act(async () => finish({ preset: "fit", width: 600, height: 800 }));
    expect(browserUseApi.resize).toHaveBeenCalledTimes(2);
    expect(browserUseApi.resize).toHaveBeenLastCalledWith(
      "task",
      "browser",
      expect.objectContaining({ width: 800 }),
    );
    expect(result.state.width).toBe(800);
  });
  it("keeps presets fixed, resumes fitting explicitly, and preserves the iframe", async () => {
    await tick();
    const frame = host.querySelector("iframe");
    await act(async () => result.select("phone"));
    vi.mocked(browserUseApi.resize).mockClear();
    size.width = 900;
    await act(async () => observe());
    await tick(9000);
    expect(browserUseApi.resize).not.toHaveBeenCalled();
    await act(async () => result.select("fit"));
    expect(browserUseApi.resize).toHaveBeenLastCalledWith(
      "task",
      "browser",
      expect.objectContaining({ preset: "fit", width: 900, takeControl: true }),
    );
    expect(host.querySelector("iframe")).toBe(frame);
  });
  it("releases ownership while hidden and when its panel is inactive", async () => {
    await tick();
    vi.mocked(browserUseApi.resize).mockClear();
    hidden = true;
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await tick(9000);
    expect(browserUseApi.resize).not.toHaveBeenCalled();
    expect(browserUseApi.releaseViewport).toHaveBeenCalled();
    hidden = false;
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await tick();
    expect(browserUseApi.resize).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<Harness active={false} />));
    await tick(9000);
    expect(browserUseApi.resize).toHaveBeenCalledTimes(1);
  });
  it("pauses failed fitting until an explicit retry and ignores stale viewer polls", async () => {
    vi.mocked(browserUseApi.resize).mockRejectedValueOnce(Error("failed"));
    const pollVersion = result.version.current;
    await tick();
    expect(result.error).toContain("Choose a size");
    await tick(16000);
    expect(browserUseApi.resize).toHaveBeenCalledTimes(1);
    await act(async () => result.select("fit"));
    expect(result.error).toBeNull();
    await act(async () => result.receive({ preset: "phone" }, pollVersion));
    expect(result.state.preset).toBe("fit");
  });
  it("does not resize a zero-sized pane and preserves aspect ratio at provider limits", async () => {
    size.width = 0;
    await act(async () => observe());
    await tick(9000);
    expect(browserUseApi.resize).not.toHaveBeenCalled();
    expect(browserPaneSize(12000, 8070, 70)).toEqual({
      width: 5184,
      height: 3456,
    });
    expect(browserPaneSize(600, 70, 70)).toBeNull();
  });
});
