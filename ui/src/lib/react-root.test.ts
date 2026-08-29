import { describe, expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";
import {
  getOrCreatePaperclipReactRoot,
  type PaperclipReactRootHost,
} from "./react-root";

describe("getOrCreatePaperclipReactRoot", () => {
  it("reuses the existing root when the entry module runs again", () => {
    const host: PaperclipReactRootHost = {};
    const container = {} as Parameters<typeof getOrCreatePaperclipReactRoot>[1];
    const root = { render: vi.fn(), unmount: vi.fn() } as unknown as Root;
    const createRoot = vi.fn(() => root);

    expect(getOrCreatePaperclipReactRoot(host, container, createRoot)).toBe(root);
    expect(getOrCreatePaperclipReactRoot(host, container, createRoot)).toBe(root);
    expect(createRoot).toHaveBeenCalledTimes(1);
    expect(createRoot).toHaveBeenCalledWith(container);
  });
});
