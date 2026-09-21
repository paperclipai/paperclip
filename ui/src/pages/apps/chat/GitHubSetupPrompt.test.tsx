// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "@/lib/clipboard";
import { GitHubSetupPrompt, githubSetupPrompt } from "./GitHubSetupPrompt";

vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

describe("GitHub setup prompt", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<GitHubSetupPrompt />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("copies the complete instructions and confirms success", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    await act(async () => container.querySelector("button")!.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith(githubSetupPrompt);
    expect(container.querySelector("button")?.textContent).toBe("Copied setup prompt");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Paste it into Codex or Claude");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("offers selectable instructions when clipboard access fails and allows retry", async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await act(async () => container.querySelector("button")!.click());
    const fallback = container.querySelector("textarea")!;
    expect(fallback.value).toBe(githubSetupPrompt);
    expect(fallback.readOnly).toBe(true);
    fallback.focus();
    expect(fallback.selectionStart).toBe(0);
    expect(fallback.selectionEnd).toBe(githubSetupPrompt.length);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not copy");
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce(undefined);
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });
});
