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

  async function openPrompt() {
    await act(async () => container.querySelector("button")!.click());
    return document.querySelector('[role="dialog"]')!;
  }

  async function copyPrompt(dialog: Element) {
    await act(async () => dialog.querySelector<HTMLButtonElement>(".agent-setup-copy")!.click());
  }

  it("copies on the opening click and confirms success in both buttons", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    const dialog = await openPrompt();
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
    expect(copyTextToClipboard).toHaveBeenCalledWith(buildSlackSetupPrompt(window.location.origin));
    expect(vi.mocked(copyTextToClipboard).mock.calls[0][0]).toContain(`Paperclip instance URL: ${window.location.origin}`);
    expect(dialog.querySelector(".agent-setup-copy")?.textContent).toBe("Copied to clipboard");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Ready to paste into your agent.");
    expect(container.querySelector("button")?.dataset.copied).toBe("true");
    expect(dialog.querySelector("textarea")).toBeNull();
  });

  it("offers selectable instructions when clipboard access fails and allows retry", async () => {
    vi.mocked(copyTextToClipboard).mockImplementationOnce(async () => {
      // The browser fallback focuses an off-screen textarea outside the popover.
      const clipboardField = document.createElement("textarea");
      document.body.append(clipboardField);
      clipboardField.focus();
      clipboardField.remove();
      throw new Error("Clipboard unavailable");
    });
    const dialog = await openPrompt();
    const fallback = dialog.querySelector("textarea")!;
    expect(fallback.value).toBe(buildSlackSetupPrompt(window.location.origin));
    expect(fallback.readOnly).toBe(true);
    fallback.focus();
    expect(fallback.selectionStart).toBe(0);
    expect(fallback.selectionEnd).toBe(fallback.value.length);
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Could not copy");
    vi.mocked(copyTextToClipboard).mockResolvedValueOnce(undefined);
    await copyPrompt(dialog);
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    expect(dialog.querySelector("textarea")).toBeNull();
  });

  it("uses the preview's configured instance instead of its Storybook host", async () => {
    await act(async () => root.render(<SlackSetupPrompt instanceUrl="https://my-company.paperclip.app" />));
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    const dialog = await openPrompt();
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
    expect(copyTextToClipboard).toHaveBeenCalledWith(buildSlackSetupPrompt("https://my-company.paperclip.app"));
  });

  it("ignores stale copy results when the prompt changes", async () => {
    let finishCopy!: () => void;
    vi.mocked(copyTextToClipboard).mockImplementationOnce(() => new Promise<void>((resolve) => { finishCopy = resolve; }));
    const dialog = await openPrompt();
    await copyPrompt(dialog);
    await copyPrompt(dialog);
    expect(copyTextToClipboard).toHaveBeenCalledTimes(1);
    expect(dialog.querySelector(".agent-setup-copy")?.textContent).toBe("Copying…");
    await act(async () => root.render(<SlackSetupPrompt instanceUrl="https://another.paperclip.app" />));
    await act(async () => finishCopy());
    expect(dialog.querySelector(".agent-setup-copy")?.textContent).toBe("Copy prompt");
    expect(dialog.querySelector("pre")?.textContent).toContain("https://another.paperclip.app");
  });

  it("copies again on every opening", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    const dialog = await openPrompt();
    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close agent setup"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => container.querySelector("button")!.click());
    expect(document.querySelector(".agent-setup-copy")?.textContent).toBe("Copied to clipboard");
    expect(copyTextToClipboard).toHaveBeenCalledTimes(2);
  });

  it("keeps the preview open when copying again from the trigger and does not copy on dismissal", async () => {
    vi.mocked(copyTextToClipboard).mockResolvedValue(undefined);
    const dialog = await openPrompt();
    await act(async () => container.querySelector("button")!.click());
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(copyTextToClipboard).toHaveBeenCalledTimes(2);
    await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close agent setup"]')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(copyTextToClipboard).toHaveBeenCalledTimes(2);
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
