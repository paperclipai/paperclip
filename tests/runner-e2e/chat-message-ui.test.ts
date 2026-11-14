import { expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { sendChatMessage } from "./chat-flow.js";

it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_MESSAGE_CANARY !== "1")("sends ordinary chat without dismissing a current form on desktop and mobile", async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      await page.setContent(`<section data-testid="task-chat-composer-takeover"><p>Launch page details</p><button aria-label="Dismiss Question">Close</button></section><div data-testid="task-chat-composer-input"><textarea></textarea></div><button data-testid="task-chat-composer-send">Send</button><script>
        window.formState = { status: "pending", dismissedAt: null, messages: [] };
        document.querySelector('[aria-label="Dismiss Question"]').onclick = () => { window.formState.dismissedAt = "dismissed"; document.querySelector('section').remove(); };
        document.querySelector('[data-testid="task-chat-composer-send"]').onclick = () => { window.formState.messages.push(document.querySelector('textarea').value); };
      </script>`);
      const message = "Walk me through the existing form before building anything.";
      await sendChatMessage(page, message, () => 5000);
      expect(await page.evaluate(() => (window as unknown as { formState: unknown }).formState)).toEqual({ status: "pending", dismissedAt: null, messages: [message] });
      expect(await page.getByTestId("task-chat-composer-takeover").isVisible()).toBe(true);
      await page.close();
    }
  } finally { await browser.close(); }
});
