// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let result = 0;
let root: Root;
let host: HTMLDivElement;

function Harness({ enabled = true }: { enabled?: boolean }) {
  result = useKeyboardInset(enabled);
  return null;
}

/** Minimal stand-in for the visualViewport the iOS keyboard moves. */
const viewport = {
  height: 800,
  offsetTop: 0,
  scale: 1,
  listeners: new Map<string, Set<() => void>>(),
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  },
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  },
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  },
};

/** The hook defers to rAF, which jsdom runs on a ~16ms timer. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 32));
  });
}

async function render(enabled = true) {
  await act(async () => {
    root.render(<Harness enabled={enabled} />);
  });
  await flush();
}

async function resizeViewport(height: number, offsetTop = 0) {
  viewport.height = height;
  viewport.offsetTop = offsetTop;
  await act(async () => {
    viewport.emit("resize");
  });
  await flush();
}

beforeEach(async () => {
  viewport.height = 800;
  viewport.offsetTop = 0;
  viewport.scale = 1;
  viewport.listeners.clear();
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

describe("useKeyboardInset", () => {
  it("reports no inset while the keyboard is closed", async () => {
    await render();
    expect(result).toBe(0);
    expect(document.documentElement.style.getPropertyValue("--sz-keyboard-inset")).toBe("0px");
    expect(document.documentElement.classList.contains("keyboard-open")).toBe(false);
  });

  it("measures the strip the keyboard covers and publishes it as a CSS variable", async () => {
    await render();
    // iOS keeps window.innerHeight at 800 and only shrinks the visual viewport.
    await resizeViewport(460);
    expect(result).toBe(340);
    expect(document.documentElement.style.getPropertyValue("--sz-keyboard-inset")).toBe("340px");
    expect(document.documentElement.classList.contains("keyboard-open")).toBe(true);
  });

  it("counts offsetTop, which iOS uses when it scrolls the field into view", async () => {
    await render();
    await resizeViewport(460, 40);
    expect(result).toBe(300);
  });

  it("ignores the ~50px Safari toolbar collapse", async () => {
    await render();
    await resizeViewport(750);
    expect(result).toBe(0);
    expect(document.documentElement.classList.contains("keyboard-open")).toBe(false);
  });

  it("ignores pinch-zoom, which also shrinks the visual viewport", async () => {
    await render();
    viewport.scale = 2;
    await resizeViewport(400);
    expect(result).toBe(0);
  });

  it("returns to zero when the keyboard closes", async () => {
    await render();
    await resizeViewport(460);
    expect(result).toBe(340);
    await resizeViewport(800);
    expect(result).toBe(0);
    expect(document.documentElement.classList.contains("keyboard-open")).toBe(false);
  });

  it("stays inert on desktop", async () => {
    await render(false);
    await resizeViewport(460);
    expect(result).toBe(0);
    expect(document.documentElement.classList.contains("keyboard-open")).toBe(false);
  });

  it("clears the variable and the class on unmount", async () => {
    await render();
    await resizeViewport(460);
    await act(async () => {
      root.unmount();
    });
    expect(document.documentElement.style.getPropertyValue("--sz-keyboard-inset")).toBe("");
    expect(document.documentElement.classList.contains("keyboard-open")).toBe(false);
    // afterEach unmounts again; React tolerates it, and the host is still live.
    await act(async () => {
      root = createRoot(host);
    });
  });
});
