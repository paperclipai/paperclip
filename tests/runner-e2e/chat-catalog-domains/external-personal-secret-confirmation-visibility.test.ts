import { expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { readVisiblePersonalSecretConfirmation, acceptPersonalSecretConfirmation } from "./external-personal-secret-confirmation.js";
import { personalSecretGuidance } from "./external-personal-secret.js";
const prompt = "Set your personal publishing credential in secure Settings Secrets, My secrets, Set my value for PERSONAL_PUBLISHING_KEY. Never paste credentials in chat. When saved, confirm this card.";
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY !== "1")("reads the production-style collapsed Details before entry and never confirms unseen targets", async () => {
  const browser = await chromium.launch({ headless: true, ...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {} }), page = await browser.newPage();
  const target = { origin: "https://paperclip.example", prefix: "RUN", definitionId: "current-definition" };
  const render = async (details: string) => page.setContent(`<div data-testid="task-chat-composer-takeover"><p>${prompt}</p><details><summary>Details</summary><div>${details}</div></details><button>Confirm</button></div>`);
  try {
    await render("Definition: current-definition");
    expect(await page.locator("details").getAttribute("open")).toBeNull();
    await expect(readVisiblePersonalSecretConfirmation(page, { prompt }, target, personalSecretGuidance, () => 500)).resolves.toMatchObject({ definitionVisible: true });
    expect(await page.locator("details").getAttribute("open")).not.toBeNull();
    const shortPrompt = "Save confirmation for current-definition";
    await page.setContent(`<div data-testid="task-chat-composer-takeover"><p>${shortPrompt}</p><details><summary>Details</summary><div>${prompt}</div></details><button>Confirm</button></div>`);
    await expect(readVisiblePersonalSecretConfirmation(page, { prompt: shortPrompt }, target, personalSecretGuidance, () => 500)).resolves.toMatchObject({ definitionVisible: true });
    await render('<a href="https://paperclip.example/RUN/company/settings/secrets?definition=current-definition">Open My secrets</a>');
    await expect(readVisiblePersonalSecretConfirmation(page, { prompt }, target, personalSecretGuidance, () => 500)).resolves.toMatchObject({ definitionVisible: true });
    for (const details of ['<span hidden>current-definition</span>', '<span style="opacity:0">current-definition</span>', '<span style="position:absolute;left:-9999px">current-definition</span>', 'Definition: foreign-definition']) {
      await render(details);
      await expect(readVisiblePersonalSecretConfirmation(page, { prompt }, target, personalSecretGuidance, () => 300)).rejects.toThrow();
    }
    await render("Definition: current-definition");
    let accepted = 0;
    await page.route("**/api/issues/source/interactions/card/accept", async route => { accepted++; await route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"accepted"}' }); });
    await page.locator("button").evaluate(button => button.addEventListener("click", () => { void fetch("https://paperclip.example/api/issues/source/interactions/card/accept", { method: "POST" }); }));
    await readVisiblePersonalSecretConfirmation(page, { prompt }, target, personalSecretGuidance, () => 500);
    await acceptPersonalSecretConfirmation(page, "source", "card", "Confirm", prompt, () => 1000);
    expect(accepted).toBe(1);
  } finally { await browser.close(); }
}, 15000);
