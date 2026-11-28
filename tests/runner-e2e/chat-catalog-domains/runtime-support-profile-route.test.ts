import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { openRuntimeAgentProfile, type RuntimeAgent } from "./runtime-support.js";

const executablePath = process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
const origin = "https://paperclip.example";
const agent: RuntimeAgent = { id: "8f2b6c1e-0000-4000-8000-000000000001", name: "Morgan", urlKey: "morgan" };

// The profile is first served on the id route; after a delay the app replaces it with the urlKey route and
// redraws, closing any open menu (cohort 14, runs-adapters.reset-session). The menu item renders 300 ms
// after the menu opens, so a menu opened before the redirect never shows "Reset sessions".
const profile = (redirectAfterMs: number) => `<header><img alt="Morgan avatar" src="data:,"></header><main id="main"></main><script>
  const draw = () => { document.querySelector("#main").innerHTML = '<button aria-label="Open actions for Morgan" id="open">⋯</button><div id="menu"></div>';
    document.querySelector("#open").onclick = () => { const menu = document.querySelector("#menu"); setTimeout(() => { const item = document.createElement("button"); item.textContent = "Reset sessions";
      item.onclick = () => { document.title = "reset"; }; menu.append(item); }, 300); }; };
  draw();
  setTimeout(() => { history.replaceState(null, "", "/COM/agents/morgan/dashboard"); draw(); }, ${redirectAfterMs});
</script>`;

it.skipIf(!existsSync(executablePath))("opens the agent's actions menu only after the profile settles on its canonical route", async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const redirectAfterMs of [0, 400, 1_500]) {
      const page = await browser.newPage({ baseURL: origin });
      await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: profile(redirectAfterMs) }));
      const ctx = { input: { page, fixtures: { company: { issuePrefix: "COM" } }, api: { get: async () => { throw new Error("Unexpected API read"); } } } } as unknown as ChatCatalogContext;
      await openRuntimeAgentProfile(ctx, agent);
      await page.getByRole("main").getByRole("button", { name: "Open actions for Morgan", exact: true }).click();
      await page.getByRole("button", { name: "Reset sessions" }).click({ timeout: 3_000 });
      expect(await page.title(), String(redirectAfterMs)).toBe("reset");
      expect(new URL(page.url()).pathname, String(redirectAfterMs)).toBe("/COM/agents/morgan/dashboard");
      await page.close();
    }
  } finally {
    await browser.close();
  }
}, 30_000);
