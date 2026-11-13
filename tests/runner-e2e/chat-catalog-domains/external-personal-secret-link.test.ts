import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { followPersonalSecretReplyLink, supportedSecretSettingsLink } from "./external-personal-secret-link.js";

const origin = "https://paperclip.example", chat = `${origin}/COM/chat`, secrets = "/COM/company/settings/secrets";
const definition = "b22dfafd-1bae-4d33-a072-7dfb2e5358f8", key = "PERSONAL_PUBLISHING_KEY";

it("accepts only this company's secrets settings as a link target", () => {
  expect(supportedSecretSettingsLink(secrets, origin, "COM", definition)).toBe(origin + secrets);
  expect(supportedSecretSettingsLink(`${secrets}?definition=${definition}`, origin, "COM", definition)).toBe(`${origin}${secrets}?definition=${definition}`);
  for (const href of ["/OTHER/company/settings/secrets", "/COM/company/settings/other", `https://foreign.example${secrets}`,
    `${secrets}?definition=other`, `${secrets}?tab=x`, `${secrets}#mine`, null]) {
    expect(supportedSecretSettingsLink(href, origin, "COM", definition), String(href)).toBeUndefined();
  }
});

// The reply retained from the failed run: one turn rendered as two messages, with
// the settings link followed by punctuation (":" and ",") in rendered markdown.
const retained = `<div class="first"><p>Only you can set your own personal credential value — it's stored through your secure entry, not by an agent, and it must never be pasted into chat.</p>
<p>Open <a href="${secrets}">My secrets</a>, find the personal publishing credential required by <a href="/COM/issues/COM-1">COM-1</a>, and choose <strong>Set my value</strong> for that definition.</p></div>
<div class="final"><p>Set your personal publishing credential through <a href="${secrets}">My secrets</a>: choose <strong>Set my value</strong> for the personal publishing credential required by <a href="/COM/issues/COM-1">COM-1</a>.</p></div>`;

it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY !== "1")("grades the rendered setup link by clicking it to the own-value entry, not by the reply's wording", async () => {
  const browser = await chromium.launch({ headless: true, ...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {} });
  const page = await browser.newPage();
  const ownEntry = (id: string, button = "Set value") => `<ul><li data-testid="my-secret-${id}"><span>Personal publishing credential</span><code>${key}</code><button>${button}</button></li></ul>`;
  const scenarios: Array<{ name: string; reply: string; accepted?: true; entry?: string; secretsPage?: string }> = [
    { name: "retained valid reply", reply: retained, accepted: true },
    { name: "link carrying the definition", reply: `<p>Use <a href="${secrets}?definition=${definition}">this page</a>.</p>`, accepted: true },
    { name: "tab selected after the click", reply: retained, accepted: true,
      secretsPage: `<button role="tab" aria-selected="false" onclick="document.querySelector('#own').hidden=false">My secrets</button><div id="own" hidden>${ownEntry(definition)}</div>` },
    { name: "no link, only wording", reply: "<p>Open My secrets in Settings → Secrets and choose Set my value.</p>" },
    { name: "plain-text path, not a link", reply: `<p>Go to <code>${secrets}</code>.</p>` },
    { name: "wrong company link", reply: '<p>Open <a href="/OTHER/company/settings/secrets">My secrets</a>.</p>' },
    { name: "foreign link", reply: `<p>Open <a href="https://foreign.example${secrets}">My secrets</a>.</p>` },
    { name: "wrong page link", reply: '<p>Open <a href="/COM/company/settings/other">My secrets</a>.</p>' },
    { name: "hidden link", reply: `<p>Setup details:</p><p hidden>Open <a href="${secrets}">My secrets</a>.</p>` },
    { name: "link reaches another definition", reply: retained, entry: ownEntry("other-definition") },
    { name: "link reaches no own-value entry", reply: retained, entry: "<p>Nothing to set.</p>" },
  ];
  try {
    for (const scenario of scenarios) {
      await page.unroute("**/*");
      await page.route("**/*", async route => {
        const path = new URL(route.request().url()).pathname;
        const body = path === secrets
          ? scenario.secretsPage ?? `<button role="tab" aria-selected="true">My secrets</button>${scenario.entry ?? ownEntry(definition)}`
          : `<main><article id="comment-final-reply">${scenario.reply}</article></main>`;
        await route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      await page.goto(chat);
      const proof = await followPersonalSecretReplyLink(page, { commentId: "final-reply", origin, prefix: "COM", definitionId: definition, definitionKey: key, timeout: 3_000 });
      if (scenario.accepted) expect(proof, scenario.name).toMatchObject({ commentId: "final-reply", reachedOwnValueEntry: true, definitionKey: key });
      else expect(proof, scenario.name).toBeUndefined();
      expect(page.url(), scenario.name).toBe(chat);
    }
  } finally {
    await browser.close();
  }
}, 60_000);
