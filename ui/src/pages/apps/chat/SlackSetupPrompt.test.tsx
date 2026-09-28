// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "@/lib/clipboard";
import { SlackSetupPrompt, buildSlackSetupPrompt, slackSetupPrompt } from "./SlackSetupPrompt";

vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

describe("Slack setup prompt", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<SlackSetupPrompt />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("copies the complete instructions and confirms success", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    await act(async () => container.querySelector("button")!.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith(buildSlackSetupPrompt(window.location.origin));
    expect(vi.mocked(copyTextToClipboard).mock.calls[0][0]).toContain(`Paperclip instance URL: ${window.location.origin}`);
    expect(container.querySelector("button")?.textContent).toBe("Copied setup prompt");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Paste it into Codex or Claude");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("offers selectable instructions when clipboard access fails and allows retry", async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await act(async () => container.querySelector("button")!.click());
    const fallback = container.querySelector("textarea")!;
    expect(fallback.value).toBe(buildSlackSetupPrompt(window.location.origin));
    expect(fallback.readOnly).toBe(true);
    fallback.focus();
    expect(fallback.selectionStart).toBe(0);
    expect(fallback.selectionEnd).toBe(fallback.value.length);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not copy");
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce(undefined);
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("uses the preview's configured instance instead of its Storybook host", async () => {
    await act(async () => root.render(<SlackSetupPrompt instanceUrl="https://my-company.paperclip.app" />));
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    await act(async () => container.querySelector("button")!.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith(buildSlackSetupPrompt("https://my-company.paperclip.app"));
  });

  it("includes only the instance origin, without URL credentials or callback state", () => {
    const prompt = buildSlackSetupPrompt("https://user:private-password@my-company.paperclip.app/GIT/apps/chat/connect?code=private-code#private-state");
    expect(prompt).toContain("Paperclip instance URL: https://my-company.paperclip.app\n");
    expect(prompt).not.toMatch(/private-password|private-code|private-state/);
    expect(prompt).toContain(slackSetupPrompt);
  });

  it.each(["", "not a URL", "javascript:alert(1)"])("asks for the URL when preview configuration is unavailable: %s", (url) => {
    expect(buildSlackSetupPrompt(url)).toMatch(/^Paperclip instance URL is unavailable\./);
  });
});
