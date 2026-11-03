// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { CopyText } from "./CopyText";
import { copyTextToClipboard } from "@/lib/clipboard";

vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.mocked(copyTextToClipboard).mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await i18n.changeLanguage("en");
});

describe("CopyText localization", () => {
  it("switches generated success and failure labels live without changing clipboard bytes", async () => {
    const raw = "Raw pairing code: A-b_123 / не переводить";
    act(() => root.render(<CopyText text={raw} />));
    await act(async () => { container.querySelector("button")!.click(); });
    expect(copyTextToClipboard).toHaveBeenLastCalledWith(raw);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Copied!");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Скопировано!");
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("Raw provider failure"));
    await act(async () => { container.querySelector("button")!.click(); });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Не удалось скопировать");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Copy failed");
    expect(container.querySelector("button")?.textContent).toBe(raw);
    expect(copyTextToClipboard).toHaveBeenCalledTimes(2);
  });

  it("preserves explicit custom success labels and accessibility data", async () => {
    act(() => root.render(<CopyText text="original bytes" copiedLabel="Custom untranslated label" ariaLabel="Original label" title="Original title" />));
    await act(async () => { await i18n.changeLanguage("ru"); container.querySelector("button")!.click(); });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Custom untranslated label");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("Original label");
    expect(container.querySelector("button")?.getAttribute("title")).toBe("Original title");
    expect(copyTextToClipboard).toHaveBeenLastCalledWith("original bytes");
  });
});
