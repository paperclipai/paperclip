import { expect, test as base, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { parse, stringify } from "yaml";
import type { AgentConfigurationInput } from "@paperclipai/shared";
import { startReviewProvider } from "../fixtures/connection-review-provider";

export { expect };

export const test = base.extend<{ toolProvider: Awaited<ReturnType<typeof startReviewProvider>>; settings: void }>({
  settings: [async ({ request }, use) => {
    const previous = await json(await request.get("/api/instance/settings/experimental"));
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableBetaSkills: true, enableChatConnectors: true } }));
      await use();
    } finally {
      await json(await request.patch("/api/instance/settings/experimental", { data: {
        enableBetaSkills: previous.enableBetaSkills, enableChatConnectors: previous.enableChatConnectors,
      } }));
    }
  }, { auto: true }],
  toolProvider: async ({}, use) => {
    const provider = await startReviewProvider();
    try { await use(provider); }
    finally { await provider.close(); }
  },
});

export async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

export async function setup(request: APIRequestContext) {
  const company = await json(await request.post("/api/companies", { data: { name: `Agent YAML ${Date.now()}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
    name: "YAML engineer", role: "engineer", adapterType: "process", adapterConfig: { command: "true", removable: "old value" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }));
  return { company, agent, url: `/${company.issuePrefix}/agents/${agent.urlKey}` };
}

export const editor = (page: Page) => page.getByRole("textbox", { name: "Agent YAML configuration" });

export async function document(page: Page): Promise<AgentConfigurationInput> {
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  let source = "";
  // Keep the selection inside the editor across configuration rerenders.
  // Never parse a whole-page selection or a prior clipboard value as YAML.
  await expect.poll(async () => {
    await editor(page).click();
    await editor(page).press("ControlOrMeta+a");
    const selectedEditor = await editor(page).evaluate(element => {
      const selection = window.getSelection();
      return window.document.activeElement === element && !!selection?.anchorNode && !!selection.focusNode
        && element.contains(selection.anchorNode) && element.contains(selection.focusNode);
    });
    if (!selectedEditor) return false;
    // Capture the editor's copy event without sharing the OS clipboard with
    // other browser tests or the person using this computer.
    source = await editor(page).evaluate(element => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
      return clipboardData.getData("text/plain");
    });
    return /^apiVersion: paperclip\/v1(?:\r?\n|$)/.test(source);
  }, { message: "Copy the current YAML from the focused editor" }).toBe(true);
  return parse(source);
}

export async function edit(page: Page, change: (value: AgentConfigurationInput) => void) {
  const value = await document(page);
  change(value);
  await editor(page).press("ControlOrMeta+a");
  await page.keyboard.insertText(stringify(value, { lineWidth: 0 }));
}

export async function save(page: Page) {
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Reload saved", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
}
