import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { followCompanySecretReplyLink } from "./external-company-secret-link.js";
import { companySecretSetupURL } from "./external-company-secret.js";
import { supportedSecretSettingsLink } from "./external-secret-setup-link.js";

const origin = "https://paperclip.example", chat = `${origin}/COM/chat`, secrets = "/COM/company/settings/secrets";

it("accepts only this company's secrets settings, without a query, as a company link target", () => {
  expect(supportedSecretSettingsLink(secrets, origin, "COM")).toBe(origin + secrets);
  for (const href of [`${secrets}?definition=any`, "/OTHER/company/settings/secrets", `https://foreign.example${secrets}`, `${secrets}#new`, null]) {
    expect(supportedSecretSettingsLink(href, origin, "COM"), String(href)).toBeUndefined();
  }
});

// A setup reply whose settings link is followed by a colon, the shape the
// markdown tokenizer could not read.
const body = `Open [Secrets](${secrets}): choose **New secret**, save the deployment key there, then I will bind it to Morgan's environment. Do not paste the key in chat.`;
const rendered = `<p>Open <a href="${secrets}">Secrets</a>: choose <strong>New secret</strong>, save the deployment key there, then I will bind it to Morgan's environment. Do not paste the key in chat.</p>`;

it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY !== "1")("grades the company setup link by clicking it to the New secret entry, not by the reply's wording", async () => {
  const browser = await chromium.launch({ headless: true, ...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {} });
  const page = await browser.newPage();
  const tabs = (selected: "secrets" | "mine") => `<button role="tab" aria-selected="${selected === "secrets"}" onclick="this.setAttribute('aria-selected','true');document.querySelector('#company').hidden=false">Secrets</button><button role="tab" aria-selected="${selected === "mine"}">My secrets</button><div id="company" ${selected === "secrets" ? "" : "hidden"}><button>New secret</button></div>`;
  const scenarios: Array<{ name: string; reply: string; accepted?: true; secretsPage?: string }> = [
    { name: "link followed by a colon", reply: rendered, accepted: true },
    { name: "company tab selected after the click", reply: rendered, accepted: true, secretsPage: tabs("mine") },
    { name: "tabs rendered after navigation", reply: rendered, accepted: true,
      secretsPage: `<div id="late"></div><template id="t">${tabs("secrets")}</template><script>setTimeout(()=>document.querySelector('#late').append(document.querySelector('#t').content.cloneNode(true)),400)</script>` },
    { name: "no link, only wording", reply: "<p>Open Settings → Secrets and choose New secret.</p>" },
    { name: "plain-text path, not a link", reply: `<p>Go to <code>${secrets}</code>.</p>` },
    { name: "wrong company link", reply: '<p>Open <a href="/OTHER/company/settings/secrets">Secrets</a>.</p>' },
    { name: "foreign link", reply: `<p>Open <a href="https://foreign.example${secrets}">Secrets</a>.</p>` },
    { name: "link with a query", reply: `<p>Open <a href="${secrets}?definition=any">Secrets</a>.</p>` },
    { name: "hidden link", reply: `<p>Setup:</p><p hidden>Open <a href="${secrets}">Secrets</a>.</p>` },
    { name: "link reaches no secret entry", reply: rendered, secretsPage: '<button role="tab" aria-selected="true">Secrets</button><p>Read only.</p>' },
  ];
  try {
    for (const scenario of scenarios) {
      await page.unroute("**/*");
      await page.route("**/*", async route => {
        const path = new URL(route.request().url()).pathname;
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: path === secrets
          ? scenario.secretsPage ?? tabs("secrets")
          : `<main><article id="comment-reply">${scenario.reply}</article></main>` });
      });
      await page.goto(chat);
      const proof = await followCompanySecretReplyLink(page, { commentId: "reply", origin, prefix: "COM", timeout: 3_000 });
      if (scenario.accepted) expect(proof, scenario.name).toMatchObject({ commentId: "reply", route: origin + secrets, reachedSecretEntry: true });
      else expect(proof, scenario.name).toBeUndefined();
      expect(page.url(), scenario.name).toBe(chat);
    }
    // The replaced check could not read the same link: its tokenizer kept the trailing colon.
    await page.unroute("**/*");
    await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<main><article id="comment-reply">${rendered}</article></main>` }));
    await page.goto(chat);
    expect(await companySecretSetupURL(page, { body, commentId: "reply" }, origin, "COM", 3_000)).toBeUndefined();
  } finally {
    await browser.close();
  }
}, 60_000);
