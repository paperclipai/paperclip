// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BubbleCopyButton, IssueChatFeedbackButtons } from "./AgentBubbleActionRow";
import { copyTextToClipboard } from "@/lib/clipboard";

vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("feedback sharing localization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
  });

  it("retranslates a failed copy without retrying or translating the message", async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValue(new Error("Clipboard blocked"));
    await act(async () => root.render(<BubbleCopyButton copyText="Agent user-authored message" />));
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-label")).toBe("Copy message");
    await act(async () => button.click());
    expect(button.title).toBe("Couldn’t copy message");
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(button.getAttribute("aria-label")).toBe("Не удалось скопировать сообщение");
    expect(copyTextToClipboard).toHaveBeenCalledExactlyOnceWith("Agent user-authored message");
  });

  it.each([true, false])("keeps a pending vote and its sharing choice while changing language (%s)", async (allowSharing) => {
    const onVote = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <IssueChatFeedbackButtons activeVote={null} sharingPreference="prompt" termsUrl="https://example.com/terms" onVote={onVote} />
        </TooltipProvider>,
      );
    });
    const up = container.querySelector<HTMLButtonElement>('button[aria-label="Helpful"]')!;
    expect(up).toBeTruthy();
    await act(async () => up.click());
    expect(document.body.textContent).toContain("this vote and future voted AI outputs");
    expect(onVote).not.toHaveBeenCalled();
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(document.body.textContent).toContain("будущие ответы ИИ, которые вы оцените");
    expect(document.body.textContent).toContain("хранить эту и будущие оценки только локально");
    expect(document.querySelector('a[href="https://example.com/terms"]')).toBeTruthy();
    expect(onVote).not.toHaveBeenCalled();
    const label = allowSharing ? i18n.t("pages.apps.review.alwaysAllow") : i18n.t("localizationSettings.dontAllow");
    const choice = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === label)!;
    expect(choice).toBeTruthy();
    await act(async () => choice.click());
    expect(onVote).toHaveBeenCalledExactlyOnceWith("up", allowSharing ? { allowSharing: true } : undefined);
  });
});
