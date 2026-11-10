// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { appearanceForPalette } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { AgentPhotoEditor, AgentPhotoFrame } from "./AgentPhotoFrame";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const setAvatarFocus = vi.hoisted(() => vi.fn());
vi.mock("../api/agents", () => ({ agentsApi: { setAvatarFocus } }));

class FakeImage {
  naturalWidth = 200;
  naturalHeight = 100;
  onload: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setAvatarFocus.mockReset();
});

it("moves a wide photo when it is dragged and saves the new center", async () => {
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100, x: 0, y: 0, toJSON() { return {}; },
  });
  setAvatarFocus.mockResolvedValue({});
  const agent = {
    id: "agent-1",
    companyId: "company-1",
    name: "Monica",
    status: "idle",
    appearance: { ...appearanceForPalette("deep-tide"), customAvatarAssetId: "22222222-2222-4222-8222-222222222222" },
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentPhotoEditor agent={agent}>
            <AgentPhotoFrame state="idle" />
          </AgentPhotoEditor>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    const frame = container.querySelector("[data-testid='agent-photo-frame']");
    expect(frame?.getAttribute("aria-label")).toContain("Center photo");
    expect(container.querySelector("img")?.style.objectPosition).toBe("50% 50%");
    await act(async () => {
      frame?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10, pointerId: 1, button: 0 }));
      frame?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 35, clientY: 10, pointerId: 1, button: 0 }));
    });
    expect(container.querySelector("img")?.style.objectPosition).toBe("25% 50%");
    await act(async () => {
      frame?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 35, clientY: 10, pointerId: 1, button: 0 }));
    });
    expect(setAvatarFocus).toHaveBeenCalledWith("company-1", "agent-1", { x: 25, y: 50 });
  } finally {
    await act(async () => root.unmount());
  }
});
