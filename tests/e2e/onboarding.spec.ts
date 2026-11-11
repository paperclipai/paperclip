import { test, expect } from "@playwright/test";
import { chooseMarketingType, createMarketingWorkspace } from "./helpers/marketing-workspace";

const COMPANY_NAME = `E2E-Marketing-${Date.now()}`;

// The fork replaces automatic CEO/task onboarding with an empty workspace and
// explicit marketing profile review. Provider login contracts are also covered
// by NewAgent's account, retry, reload, and approval tests.
test.describe("Marketing workspace onboarding", () => {
  test("creates an empty workspace and requires one of twelve profiles before saving a held agent", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const workspace = await createMarketingWorkspace(page, COMPANY_NAME);
    for (const collection of ["agents", "issues", "goals"]) {
      const response = await page.request.get(`/api/companies/${workspace.id}/${collection}`);
      expect(response.ok()).toBe(true);
      expect(await response.json()).toEqual([]);
    }
    // An empty marketing workspace must remain usable without a forced wizard.
    await page.goto(`/${workspace.issuePrefix}/dashboard`);
    await expect(page.getByRole("button", { name: "Create one here", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto(`/${workspace.issuePrefix}/agents/new`);
    await page.getByLabel("Nome do agente", { exact: true }).fill("Sofia");
    await expect(page.getByRole("button", { name: "Choose adapter", exact: true })).toBeDisabled();
    await page.getByLabel("Tipo de agente", { exact: true }).click();
    await expect(page.getByRole("option")).toHaveCount(12);
    await page.getByRole("option", { name: "Designer", exact: true }).click();
    await page.getByLabel("Responsabilidades", { exact: true }).fill("Criar a identidade visual da nossa marca.");
    const created = page.waitForResponse(response => response.request().method() === "POST"
      && response.url().endsWith(`/api/companies/${workspace.id}/agents`));
    await page.getByRole("button", { name: "Choose adapter", exact: true }).click();
    const draft = await (await created).json();
    expect(draft).toMatchObject({ name: "Sofia", pauseReason: "setup", metadata: {
      setupAdapterPending: true, marketingAgent: { typeId: "designer", responsibilities: "Criar a identidade visual da nossa marca." },
    } });
    expect(draft.role).not.toBe("ceo");
    expect(draft.runtimeConfig.heartbeat.enabled).toBe(false);
    await expect(page.getByRole("heading", { name: "Choose an adapter", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto(`/${workspace.issuePrefix}/agents/${draft.id}`);
    await expect(page.getByRole("button", { name: "Run now", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Finish setup", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Finish setup", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose an adapter", exact: true })).toBeVisible();
    await page.locator('label').filter({ has: page.locator('input[name="new-agent-adapter"][value="codex_local"]') }).click();
    await page.getByRole("button", { name: "Configure agent", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connect a model", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("setupAgentId")).toBe(draft.id);
    const saved = await (await page.request.get(`/api/agents/${draft.id}?companyId=${workspace.id}`)).json();
    expect(saved.metadata.marketingAgent).toEqual(draft.metadata.marketingAgent);
    expect(saved.pauseReason).toBe("setup");
    expect(await (await page.request.get(`/api/companies/${workspace.id}/agents`)).json()).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("direct setup links still require a profile before any agent is created", async ({ page }) => {
    const response = await page.request.post("/api/companies", { data: { name: COMPANY_NAME + "-direct" } });
    expect(response.ok()).toBe(true);
    const workspace = await response.json();
    await page.goto(`/${workspace.issuePrefix}/agents/new?name=Unreviewed&adapterType=codex_local`);
    await expect(page.getByRole("heading", { name: "Crie seu agente de marketing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose adapter", exact: true })).toBeDisabled();
    expect(await (await page.request.get(`/api/companies/${workspace.id}/agents`)).json()).toEqual([]);
  });

  test("name-only setup saves the advanced Grok ACPX adapter on the same record", async ({ page }) => {
    const previous = await (await page.request.get("/api/instance/settings/experimental")).json();
    await page.request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: true } });
    try {
      const response = await page.request.post("/api/companies", { data: { name: `${COMPANY_NAME}-grok-setup` } });
      expect(response.ok()).toBe(true);
      const company = await response.json();
      await page.goto(`/${company.issuePrefix}/agents/all`);
      await page.getByRole("toolbar", { name: "Agents controls" }).getByRole("button", { name: "New Agent", exact: true }).click();
      await page.getByLabel("Nome do agente", { exact: true }).fill("Galen");
      await chooseMarketingType(page);
      const setupResponse = page.waitForResponse(result => result.request().method() === "POST"
        && result.url().endsWith(`/api/companies/${company.id}/agents`));
      await page.getByRole("button", { name: "Choose adapter", exact: true }).click();
      const setup = await (await setupResponse).json();
      await page.locator("summary").filter({ hasText: "Advanced" }).click();
      await page.getByRole("button", { name: "Experimental harness", exact: true }).click();
      await page.getByRole("option", { name: "Grok Build (Paperclip Runner)", exact: true }).click();
      await page.getByRole("button", { name: "Configure agent", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Connect a model", exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("setupAgentId")).toBe(setup.id);
      const saved = await (await page.request.get(`/api/agents/${setup.id}?companyId=${company.id}`)).json();
      expect(saved).toMatchObject({ id: setup.id, adapterType: "paperclip_runner", pauseReason: "setup",
        adapterConfig: { provider: "acpx", acpxAgent: "grok", model: "grok-4.7" }, metadata: { setupAdapterPending: false } });
    } finally {
      await page.request.patch("/api/instance/settings/experimental", { data: { enableNativeRunner: previous.enableNativeRunner === true } });
    }
  });

  test("duplicate name drafts can select Copilot before connecting a GitHub account", async ({ page }) => {
    const response = await page.request.post("/api/companies", { data: { name: `${COMPANY_NAME}-duplicate-copilot` } });
    expect(response.ok()).toBe(true);
    const company = await response.json();
    await page.goto(`/${company.issuePrefix}/agents/all`);
    let duplicate: { id: string; name: string };
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.getByRole("toolbar", { name: "Agents controls" }).getByRole("button", { name: "New Agent", exact: true }).click();
      await page.getByLabel("Nome do agente", { exact: true }).fill("Echo");
      await chooseMarketingType(page);
      const setupResponse = page.waitForResponse(result => result.request().method() === "POST" && result.url().endsWith(`/api/companies/${company.id}/agents`));
      await page.getByRole("button", { name: "Choose adapter", exact: true }).click();
      duplicate = await (await setupResponse).json();
      await expect(page.getByRole("heading", { name: "Choose an adapter", exact: true })).toBeVisible();
      if (attempt === 0) await page.keyboard.press("Escape");
    }
    expect(duplicate!.name).toBe("Echo 2");
    await expect(page.getByText("How should Echo 2 work?", { exact: true })).toBeVisible();
    await page.locator("label").filter({ has: page.locator('input[name="new-agent-adapter"][value="copilot_runtime"]') }).click();
    await page.getByRole("button", { name: "Configure agent", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Configure your agent", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("setupAgentId")).toBe(duplicate!.id);
    const saved = await (await page.request.get(`/api/agents/${duplicate!.id}?companyId=${company.id}`)).json();
    expect(saved).toMatchObject({ id: duplicate!.id, name: "Echo 2", pauseReason: "setup", adapterConfig: { provider: "acpx", acpxAgent: "copilot" } });
    expect(saved.runtimeConfig.aiConnection).toBeUndefined();
  });

});
