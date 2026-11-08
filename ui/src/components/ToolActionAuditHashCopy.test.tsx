// @vitest-environment jsdom
import { i18n } from "@/i18n";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyTextToClipboard = vi.fn<(text: string) => Promise<void>>();
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: (text: string) => copyTextToClipboard(text) }));

import { ToolActionAuditHashCopy } from "./ToolActionAuditHashCopy";

const hash = "8ca5312877235a4c0f6e9b1d2a7c3e5f9081b2c4d6e8fa1b3c5d7e9f0a2b4c6d";

describe("ToolActionAuditHashCopy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    copyTextToClipboard.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    act(() => root.unmount());
    await i18n.changeLanguage("en");
    container.remove();
  });

  it("updates copy feedback on a locale switch without changing the raw hash", async () => {
    copyTextToClipboard.mockRejectedValue(new Error("blocked"));
    await act(async () => root.render(<ToolActionAuditHashCopy hash={hash} />));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => { await i18n.changeLanguage("zh-CN"); });
    expect(container.textContent).toContain("无法复制");
    expect(container.querySelector('[aria-label="审计哈希"]')?.textContent).toBe(hash);
    expect(copyTextToClipboard).toHaveBeenCalledWith(hash);
  });

  it("copies the hash without showing it", async () => {
    copyTextToClipboard.mockResolvedValue(undefined);
    await act(async () => root.render(<ToolActionAuditHashCopy hash={hash} />));
    expect(container.textContent).toBe("Copy audit hash");
    await act(async () => container.querySelector("button")!.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith(hash);
    expect(container.textContent).toBe("Copied");
  });

  it("shows the hash as selectable text when the clipboard is blocked", async () => {
    copyTextToClipboard.mockRejectedValue(new Error("blocked"));
    await act(async () => root.render(<ToolActionAuditHashCopy hash={hash} />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Couldn’t copy");
    expect(container.textContent).toContain(hash);
  });
});
