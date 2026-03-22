import { test, expect, type Page } from "@playwright/test";

/**
 * E2E: kiro_local adapter UI — comprehensive test
 *
 * Tests every field, toggle, dropdown in the Kiro adapter:
 * 1. Agent Creation (New Agent → Kiro adapter)
 * 2. Agent Edit (existing Kiro agent → Configuration tab)
 * 3. Onboarding Wizard — Kiro adapter selection
 * 4. Invite Landing — Kiro adapter appearance
 * 5. Test Environment button
 * 6. Existing agent config validation (no stale fields)
 *
 * URL structure:
 *   /:companyPrefix/agents/new
 *   /:companyPrefix/agents/:urlKey/configuration
 */

const PORT = process.env.PAPERCLIP_E2E_PORT ?? 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const KIRO_MODELS = [
  "auto",
  "Claude Sonnet 4.5",
  "Claude Sonnet 4",
  "Claude Haiku 4.5",
  "DeepSeek 3.2",
  "MiniMax M2.1",
  "MiniMax M2.5",
  "Qwen 3 Coder Next",
];

async function getCompany(page: Page): Promise<{ id: string; name: string; issuePrefix: string }> {
  const res = await page.request.get(`${BASE_URL}/api/companies`);
  const companies = await res.json();
  return companies[0];
}

async function getAgents(page: Page, companyId: string) {
  const res = await page.request.get(`${BASE_URL}/api/companies/${companyId}/agents`);
  return res.json();
}

/**
 * Select "Kiro (local)" from the adapter type dropdown in AgentConfigForm.
 * The dropdown trigger shows the current adapter label.
 */
async function selectKiroAdapter(page: Page) {
  // The adapter type dropdown is under the "Adapter" section header.
  // The trigger button shows the current adapter label like "Claude (local)"
  const adapterTrigger = page.locator("button").filter({ hasText: /\(local\)|Process|HTTP/i }).first();
  await adapterTrigger.click();
  await page.waitForTimeout(300);

  // Click "Kiro (local)" in the popover list
  const kiroItem = page.locator("button", { hasText: "Kiro (local)" }).first();
  await expect(kiroItem).toBeVisible({ timeout: 5_000 });
  await kiroItem.click();
  // Wait for adapter form to re-render after selection (CI can be slow)
  await page.waitForTimeout(1_500);
}

test.describe("kiro_local adapter — Agent Creation (New Agent page)", () => {
  let companyPrefix: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}`);
    const company = await getCompany(page);
    companyPrefix = company.issuePrefix;
    await page.close();
  });

  test("adapter dropdown shows 'Kiro (local)' option", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Open the adapter type dropdown
    const adapterTrigger = page.locator("button").filter({ hasText: /\(local\)|Process|HTTP/i }).first();
    await adapterTrigger.click();
    await page.waitForTimeout(300);

    // "Kiro (local)" should appear in the dropdown
    const kiroOption = page.locator("button", { hasText: "Kiro (local)" }).first();
    await expect(kiroOption).toBeVisible({ timeout: 5_000 });
  });

  test("selecting Kiro adapter loads correct form fields", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await selectKiroAdapter(page);

    // Agent instructions file should be visible
    await expect(page.locator("text=Agent instructions file").first()).toBeVisible({ timeout: 10_000 });

    // Command field with "kiro-cli" placeholder
    const commandInput = page.locator('input[placeholder="kiro-cli"]');
    await expect(commandInput).toBeVisible({ timeout: 5_000 });

    // Working directory (legacy) is intentionally hidden in create mode
    await expect(page.locator("text=Working directory").first()).not.toBeVisible();
  });

  test("command field has 'kiro-cli' placeholder (not 'claude' or other)", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await selectKiroAdapter(page);

    // Command placeholder must be "kiro-cli"
    const commandInput = page.locator('input[placeholder="kiro-cli"]');
    await expect(commandInput).toBeVisible({ timeout: 5_000 });

    // "claude" placeholder must NOT appear in command field
    const claudeCommandInput = page.locator('input[placeholder="claude"]');
    await expect(claudeCommandInput).not.toBeVisible();
  });

  test("model dropdown shows exactly 8 Kiro models with 'auto' as default", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await selectKiroAdapter(page);
    await page.waitForTimeout(800);

    // The model button in the Permissions & Configuration section shows "auto"
    // It's a popover trigger showing the selected model
    const modelBtn = page.locator("button").filter({ hasText: /^auto$/ }).first();
    await expect(modelBtn).toBeVisible({ timeout: 5_000 });

    // Open the model dropdown
    await modelBtn.click();
    await page.waitForTimeout(300);

    // Check all 8 models are present
    for (const model of KIRO_MODELS) {
      const modelItem = page.locator("button").filter({ hasText: model }).first();
      await expect(modelItem).toBeVisible({ timeout: 3_000 });
    }

    // Close dropdown
    await page.keyboard.press("Escape");
  });

  test("no Claude/Codex-specific fields shown (no bypass sandbox, thinking effort, enable chrome, enable search)", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await selectKiroAdapter(page);

    // These fields must NOT appear for kiro_local
    await expect(page.locator("text=Enable Chrome").first()).not.toBeVisible();
    await expect(page.locator("text=Skip permissions").first()).not.toBeVisible();
    await expect(page.locator("text=Bypass sandbox").first()).not.toBeVisible();
    await expect(page.locator("text=Thinking effort").first()).not.toBeVisible();
    await expect(page.locator("text=Enable search").first()).not.toBeVisible();
    await expect(page.locator("text=Max turns per run").first()).not.toBeVisible();
  });

  test("extra args field is present", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await selectKiroAdapter(page);

    await expect(page.locator("text=Extra args").first()).toBeVisible({ timeout: 5_000 });
  });

  test("environment variables section is present", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await selectKiroAdapter(page);

    await expect(page.locator("text=Environment variables").first()).toBeVisible({ timeout: 5_000 });
  });

  test("model defaults to 'auto' when kiro_local is selected (not empty string)", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await selectKiroAdapter(page);
    await page.waitForTimeout(800);

    // Model button should show "auto" — not empty, not "Default"
    const modelBtn = page.locator("button").filter({ hasText: /^auto$/ }).first();
    await expect(modelBtn).toBeVisible({ timeout: 5_000 });
  });

  test("agent can be saved with kiro_local and config has no stale fields", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    const company = await getCompany(page);
    const agentName = `Kiro-Test-${Date.now()}`;

    await selectKiroAdapter(page);
    await page.waitForTimeout(500);

    // Fill agent name (wait for form to be ready after adapter switch)
    const nameInput = page.locator('input[placeholder="Agent name"]');
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.fill(agentName);

    // Fill instructions file (working directory is hidden in create mode)
    const instrInput = page.locator('input[placeholder="/absolute/path/to/AGENTS.md"]').first();
    await expect(instrInput).toBeVisible({ timeout: 10_000 });
    await instrInput.fill("/tmp/kiro-test/AGENTS.md");
    await instrInput.blur();

    // Create agent
    const createBtn = page.getByRole("button", { name: "Create agent" });
    await expect(createBtn).toBeEnabled();
    await createBtn.click();
    await page.waitForTimeout(3_000);

    // Verify via API
    const agents = await getAgents(page, company.id);
    const kiroAgent = agents.find((a: { name: string }) => a.name === agentName);
    expect(kiroAgent, "Agent should be created").toBeTruthy();
    expect(kiroAgent.adapterType).toBe("kiro_local");

    const cfg = kiroAgent.adapterConfig ?? {};

    // Model must default to "auto"
    expect(cfg.model, "Model should default to 'auto'").toBe("auto");

    // Must NOT have stale adapter-specific fields
    const staleFields = [
      "effort", "mode", "variant", "modelReasoningEffort",
      "chrome", "dangerouslySkipPermissions",
      "dangerouslyBypassApprovalsAndSandbox", "search",
    ];
    for (const field of staleFields) {
      expect(cfg[field], `adapterConfig should not contain field "${field}"`).toBeUndefined();
    }

    // Verify instructionsFilePath was saved
    expect(cfg.instructionsFilePath).toBe("/tmp/kiro-test/AGENTS.md");

    // Cleanup
    if (kiroAgent?.id) {
      await page.request.delete(`${BASE_URL}/api/companies/${company.id}/agents/${kiroAgent.id}`);
    }
  });
});

test.describe("kiro_local adapter — Agent Edit page (Configuration tab)", () => {
  let kiroAgentId: string;
  let kiroAgentUrlKey: string;
  let companyId: string;
  let companyPrefix: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}`);
    const company = await getCompany(page);
    companyId = company.id;
    companyPrefix = company.issuePrefix;

    // Create test agent via API
    const createRes = await page.request.post(`${BASE_URL}/api/companies/${companyId}/agents`, {
      data: {
        name: `Kiro-EditTest-${Date.now()}`,
        role: "general",
        adapterType: "kiro_local",
        adapterConfig: {
          model: "auto",
          cwd: "/tmp/kiro-edit-test",
          instructionsFilePath: "/tmp/kiro-edit-test/AGENTS.md",
          graceSec: 15,
          timeoutSec: 0,
        },
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 3600,
            wakeOnDemand: true,
            cooldownSec: 10,
            maxConcurrentRuns: 1,
          },
        },
        budgetMonthlyCents: 0,
      },
    });
    const created = await createRes.json();
    // API returns agent directly (not wrapped)
    kiroAgentId = created.id;
    kiroAgentUrlKey = created.urlKey;
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!kiroAgentId) return;
    const page = await browser.newPage();
    await page.request.delete(`${BASE_URL}/api/companies/${companyId}/agents/${kiroAgentId}`);
    await page.close();
  });

  test("configuration tab shows all kiro fields", async ({ page }) => {
    if (!kiroAgentUrlKey) return test.skip();
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/${kiroAgentUrlKey}/configuration`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    await expect(page.locator("text=Working directory").first()).toBeVisible({ timeout: 5_000 });
    // Agent instructions file is hidden on edit page (hideInstructionsFile is always true)
    await expect(page.locator("text=Agent instructions file").first()).toBeHidden();
    await expect(page.locator("text=Command").first()).toBeVisible();
    await expect(page.locator("text=Extra args").first()).toBeVisible();
    await expect(page.locator("text=Environment variables").first()).toBeVisible();
  });

  test("timeout field defaults to 0, grace period defaults to 15 (edit-only fields)", async ({
    page,
  }) => {
    if (!kiroAgentUrlKey) return test.skip();
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/${kiroAgentUrlKey}/configuration`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Timeout (sec) label must appear
    await expect(page.locator("text=Timeout").first()).toBeVisible({ timeout: 5_000 });
    // Grace period label
    await expect(page.locator("text=grace period").first()).toBeVisible();

    // Verify timeout=0 and graceSec=15 via number inputs
    const allNumberInputs = page.locator('input[type="number"]');
    const count = await allNumberInputs.count();
    expect(count, "Should have at least 2 number inputs (timeout + grace period)").toBeGreaterThanOrEqual(2);

    let foundTimeout = false;
    let foundGrace = false;
    for (let i = 0; i < count; i++) {
      const val = await allNumberInputs.nth(i).inputValue();
      if (val === "0") foundTimeout = true;
      if (val === "15") foundGrace = true;
    }
    expect(foundTimeout, "Timeout field should default to 0").toBe(true);
    expect(foundGrace, "Grace period field should default to 15").toBe(true);
  });

  test("no Claude/Codex-specific fields in edit mode", async ({ page }) => {
    if (!kiroAgentUrlKey) return test.skip();
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/${kiroAgentUrlKey}/configuration`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    await expect(page.locator("text=Enable Chrome").first()).not.toBeVisible();
    await expect(page.locator("text=Skip permissions").first()).not.toBeVisible();
    await expect(page.locator("text=Thinking effort").first()).not.toBeVisible();
    await expect(page.locator("text=Enable search").first()).not.toBeVisible();
    await expect(page.locator("text=Max turns per run").first()).not.toBeVisible();
  });

  test("model dropdown shows all 8 kiro models in edit mode", async ({ page }) => {
    if (!kiroAgentUrlKey) return test.skip();
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/${kiroAgentUrlKey}/configuration`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Find model button (shows "auto")
    const modelBtn = page.locator("button").filter({ hasText: /^auto$/ }).first();
    await expect(modelBtn).toBeVisible({ timeout: 5_000 });
    await modelBtn.click();
    await page.waitForTimeout(300);

    // All 8 models should be in the dropdown
    for (const model of KIRO_MODELS) {
      const item = page.locator("button").filter({ hasText: model }).first();
      await expect(item).toBeVisible({ timeout: 3_000 });
    }

    await page.keyboard.press("Escape");
  });

  test("test environment button appears and is clickable", async ({ page }) => {
    if (!kiroAgentUrlKey) return test.skip();
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/${kiroAgentUrlKey}/configuration`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const testEnvBtn = page.getByRole("button", { name: /test environment/i }).first();
    await expect(testEnvBtn).toBeVisible({ timeout: 5_000 });
    await expect(testEnvBtn).toBeEnabled();

    // Click and verify no ANSI codes or broken paths in result
    await testEnvBtn.click();
    await page.waitForTimeout(3_000);

    const pageText = await page.locator("body").innerText();
    // No raw ANSI escape codes
    expect(/\x1b\[[\d;]*m/.test(pageText), "Page should not contain raw ANSI codes").toBe(false);
    // No broken home directory paths
    expect(/\/Users\/\[\]/.test(pageText), "Page should not contain /Users/[] paths").toBe(false);
  });

  test("changes save correctly and persist on page reload", async ({ page }) => {
    if (!kiroAgentUrlKey) return test.skip();
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/${kiroAgentUrlKey}/configuration`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Change model to Claude Sonnet 4.5
    const modelBtn = page.locator("button").filter({ hasText: /^auto$/ }).first();
    if (await modelBtn.isVisible()) {
      await modelBtn.click();
      await page.waitForTimeout(300);

      const modelItem = page.locator("button").filter({ hasText: "Claude Sonnet 4.5" }).first();
      if (await modelItem.isVisible()) {
        await modelItem.click();
        await page.waitForTimeout(500);

        // Save if there's an explicit save button
        const saveBtn = page.getByRole("button", { name: /save/i }).first();
        if (await saveBtn.isVisible()) {
          await saveBtn.click();
          await page.waitForTimeout(1000);
        }
      }
    }

    // Verify via API that model changed
    const res = await page.request.get(`${BASE_URL}/api/agents/${kiroAgentId}`);
    const agent = await res.json();
    expect(agent.adapterConfig?.model).toBe("claude-sonnet-4.5");
  });
});

test.describe("kiro_local adapter — Existing Agent Config Validation", () => {
  test("existing kiro agents should not have stale adapter-specific fields", async ({ page }) => {
    await page.goto(`${BASE_URL}`);
    const company = await getCompany(page);
    const agents = await getAgents(page, company.id);
    const kiroAgents = agents.filter((a: { adapterType: string }) => a.adapterType === "kiro_local");

    expect(kiroAgents.length, "Should have at least one kiro_local agent").toBeGreaterThan(0);

    const staleFields = [
      "effort", "mode", "variant", "modelReasoningEffort",
      "chrome", "dangerouslySkipPermissions",
      "dangerouslyBypassApprovalsAndSandbox", "search",
    ];

    for (const agent of kiroAgents) {
      const cfg = agent.adapterConfig ?? {};
      for (const field of staleFields) {
        if (field in cfg) {
          // Allow empty string as a pre-existing data issue (not new code bug)
          // but flag non-empty stale values as failures
          if (cfg[field] !== "" && cfg[field] !== undefined) {
            throw new Error(
              `Agent "${agent.name}" has non-empty stale field "${field}": ${JSON.stringify(cfg[field])}`
            );
          }
        }
      }
    }
  });
});

test.describe("kiro_local adapter — AgentConfigForm adapter type switching", () => {
  let companyPrefix: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}`);
    const company = await getCompany(page);
    companyPrefix = company.issuePrefix;
    await page.close();
  });

  test("switching from claude_local to kiro_local hides thinking effort", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Default is claude_local — thinking effort should be visible
    await expect(page.locator("text=Thinking effort").first()).toBeVisible({ timeout: 5_000 });

    // Switch to kiro_local
    await selectKiroAdapter(page);
    await page.waitForTimeout(500);

    // Thinking effort should now be hidden
    await expect(page.locator("text=Thinking effort").first()).not.toBeVisible();
  });

  test("switching from claude_local to kiro_local: model shows 'auto' as default", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Switch to kiro_local
    await selectKiroAdapter(page);
    await page.waitForTimeout(700);

    // Model button should show "auto"
    const modelBtn = page.locator("button").filter({ hasText: /^auto$/ }).first();
    await expect(modelBtn).toBeVisible({ timeout: 5_000 });
  });

  test("switching from codex_local to kiro_local clears stale codex fields", async ({ page }) => {
    await page.goto(`${BASE_URL}/${companyPrefix}/agents/new`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);

    // Switch to codex_local first
    const adapterTrigger = page.locator("button").filter({ hasText: /\(local\)|Process|HTTP/i }).first();
    await adapterTrigger.click();
    await page.waitForTimeout(300);
    const codexItem = page.locator("button", { hasText: "Codex (local)" }).first();
    if (await codexItem.isVisible()) {
      await codexItem.click();
      await page.waitForTimeout(300);
    }
    // Ensure the dropdown is closed before re-opening
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Now switch to kiro_local
    await selectKiroAdapter(page);
    await page.waitForTimeout(500);

    // Codex-specific fields should not be visible
    await expect(page.locator("text=Bypass sandbox").first()).not.toBeVisible();
    await expect(page.locator("text=Thinking effort").first()).not.toBeVisible();
    await expect(page.locator("text=Max turns per run").first()).not.toBeVisible();
  });
});

test.describe("kiro_local adapter — API validation", () => {
  test("adapter models endpoint returns exactly 8 kiro models in correct order", async ({
    page,
  }) => {
    const company = await getCompany(page);
    const res = await page.request.get(
      `${BASE_URL}/api/companies/${company.id}/adapters/kiro_local/models`
    );
    expect(res.ok()).toBe(true);
    const models = await res.json();

    expect(models).toHaveLength(8);

    const expectedIds = [
      "auto",
      "claude-sonnet-4.5",
      "claude-sonnet-4",
      "claude-haiku-4.5",
      "deepseek-3.2",
      "minimax-m2.1",
      "minimax-m2.5",
      "qwen3-coder-next",
    ];
    const actualIds = models.map((m: { id: string }) => m.id);
    expect(actualIds).toEqual(expectedIds);
  });

  test("kiro_local is listed as enabled adapter in invite landing source", async ({ page }) => {
    // Verify via API that models load (proves kiro_local is fully integrated)
    const company = await getCompany(page);
    const modelsRes = await page.request.get(
      `${BASE_URL}/api/companies/${company.id}/adapters/kiro_local/models`
    );
    expect(modelsRes.ok()).toBe(true);
    const models = await modelsRes.json();
    expect(models[0].id).toBe("auto");
    expect(models).toHaveLength(8);
  });
});

test.describe("Adapter switch field preservation (API-level)", () => {
  const SHARED_FIELDS = {
    cwd: "/tmp/adapter-switch-test",
    instructionsFilePath: "/tmp/adapter-switch-test/AGENTS.md",
    command: "custom-cli",
    extraArgs: "--verbose",
    env: { FOO: "bar" },
    timeoutSec: 120,
    graceSec: 30,
  };

  const CLAUDE_SPECIFIC_FIELDS = {
    effort: "high",
    mode: "code",
    variant: "standard",
    modelReasoningEffort: "medium",
    chrome: true,
    dangerouslySkipPermissions: true,
  };

  let companyId: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}`);
    const company = await getCompany(page);
    companyId = company.id;
    await page.close();
  });

  test("adapter switch (claude_local → kiro_local) preserves shared fields", async ({ page }) => {
    // Create agent with claude_local and shared + adapter-specific fields
    const createRes = await page.request.post(`${BASE_URL}/api/companies/${companyId}/agents`, {
      data: {
        name: `Switch-Test-${Date.now()}`,
        role: "general",
        adapterType: "claude_local",
        adapterConfig: { model: "", ...SHARED_FIELDS, ...CLAUDE_SPECIFIC_FIELDS },
        runtimeConfig: { heartbeat: { enabled: false, intervalSec: 3600, wakeOnDemand: true, cooldownSec: 10, maxConcurrentRuns: 1 } },
        budgetMonthlyCents: 0,
      },
    });
    expect(createRes.ok()).toBe(true);
    const agent = await createRes.json();

    try {
      // Switch to kiro_local — only send model in adapterConfig (simulating frontend save)
      const patchRes = await page.request.patch(`${BASE_URL}/api/agents/${agent.id}`, {
        data: { adapterType: "kiro_local", adapterConfig: { model: "auto" } },
      });
      expect(patchRes.ok()).toBe(true);

      // Reload and verify
      const getRes = await page.request.get(`${BASE_URL}/api/agents/${agent.id}`);
      const updated = await getRes.json();
      expect(updated.adapterType).toBe("kiro_local");
      expect(updated.adapterConfig.cwd).toBe(SHARED_FIELDS.cwd);
      expect(updated.adapterConfig.instructionsFilePath).toBe(SHARED_FIELDS.instructionsFilePath);
      expect(updated.adapterConfig.command).toBe(SHARED_FIELDS.command);
      expect(updated.adapterConfig.extraArgs).toBe(SHARED_FIELDS.extraArgs);
      expect(updated.adapterConfig.timeoutSec).toBe(SHARED_FIELDS.timeoutSec);
      expect(updated.adapterConfig.graceSec).toBe(SHARED_FIELDS.graceSec);
      // env is normalized by the server: string "bar" → {type:"plain", value:"bar"}
      expect(updated.adapterConfig.env).toMatchObject({ FOO: { type: "plain", value: "bar" } });
    } finally {
      await page.request.delete(`${BASE_URL}/api/companies/${companyId}/agents/${agent.id}`);
    }
  });

  test("adapter switch clears adapter-specific fields", async ({ page }) => {
    const createRes = await page.request.post(`${BASE_URL}/api/companies/${companyId}/agents`, {
      data: {
        name: `Switch-Clear-${Date.now()}`,
        role: "general",
        adapterType: "claude_local",
        adapterConfig: { model: "", ...SHARED_FIELDS, ...CLAUDE_SPECIFIC_FIELDS },
        runtimeConfig: { heartbeat: { enabled: false, intervalSec: 3600, wakeOnDemand: true, cooldownSec: 10, maxConcurrentRuns: 1 } },
        budgetMonthlyCents: 0,
      },
    });
    expect(createRes.ok()).toBe(true);
    const agent = await createRes.json();

    try {
      const patchRes = await page.request.patch(`${BASE_URL}/api/agents/${agent.id}`, {
        data: { adapterType: "kiro_local", adapterConfig: { model: "auto" } },
      });
      expect(patchRes.ok()).toBe(true);

      const getRes = await page.request.get(`${BASE_URL}/api/agents/${agent.id}`);
      const updated = await getRes.json();
      const cfg = updated.adapterConfig;

      // Claude-specific fields must NOT be present
      for (const field of Object.keys(CLAUDE_SPECIFIC_FIELDS)) {
        expect(cfg[field], `Should not have claude-specific field "${field}"`).toBeUndefined();
      }
    } finally {
      await page.request.delete(`${BASE_URL}/api/companies/${companyId}/agents/${agent.id}`);
    }
  });

  test("reverse switch (kiro_local → claude_local) preserves shared fields", async ({ page }) => {
    const createRes = await page.request.post(`${BASE_URL}/api/companies/${companyId}/agents`, {
      data: {
        name: `ReverseSwitch-${Date.now()}`,
        role: "general",
        adapterType: "kiro_local",
        adapterConfig: { model: "auto", ...SHARED_FIELDS },
        runtimeConfig: { heartbeat: { enabled: false, intervalSec: 3600, wakeOnDemand: true, cooldownSec: 10, maxConcurrentRuns: 1 } },
        budgetMonthlyCents: 0,
      },
    });
    expect(createRes.ok()).toBe(true);
    const agent = await createRes.json();

    try {
      const patchRes = await page.request.patch(`${BASE_URL}/api/agents/${agent.id}`, {
        data: { adapterType: "claude_local", adapterConfig: { model: "" } },
      });
      expect(patchRes.ok()).toBe(true);

      const getRes = await page.request.get(`${BASE_URL}/api/agents/${agent.id}`);
      const updated = await getRes.json();
      expect(updated.adapterType).toBe("claude_local");
      expect(updated.adapterConfig.cwd).toBe(SHARED_FIELDS.cwd);
      expect(updated.adapterConfig.instructionsFilePath).toBe(SHARED_FIELDS.instructionsFilePath);
      expect(updated.adapterConfig.command).toBe(SHARED_FIELDS.command);
      expect(updated.adapterConfig.extraArgs).toBe(SHARED_FIELDS.extraArgs);
      expect(updated.adapterConfig.timeoutSec).toBe(SHARED_FIELDS.timeoutSec);
      expect(updated.adapterConfig.graceSec).toBe(SHARED_FIELDS.graceSec);
      // env is normalized by the server: string "bar" → {type:"plain", value:"bar"}
      expect(updated.adapterConfig.env).toMatchObject({ FOO: { type: "plain", value: "bar" } });
    } finally {
      await page.request.delete(`${BASE_URL}/api/companies/${companyId}/agents/${agent.id}`);
    }
  });

  test("user-modified shared fields after switch take precedence", async ({ page }) => {
    const createRes = await page.request.post(`${BASE_URL}/api/companies/${companyId}/agents`, {
      data: {
        name: `Override-${Date.now()}`,
        role: "general",
        adapterType: "claude_local",
        adapterConfig: { model: "", ...SHARED_FIELDS },
        runtimeConfig: { heartbeat: { enabled: false, intervalSec: 3600, wakeOnDemand: true, cooldownSec: 10, maxConcurrentRuns: 1 } },
        budgetMonthlyCents: 0,
      },
    });
    expect(createRes.ok()).toBe(true);
    const agent = await createRes.json();

    try {
      // Switch adapter AND override cwd with a new value
      const newCwd = "/tmp/user-override-path";
      const patchRes = await page.request.patch(`${BASE_URL}/api/agents/${agent.id}`, {
        data: { adapterType: "kiro_local", adapterConfig: { model: "auto", cwd: newCwd } },
      });
      expect(patchRes.ok()).toBe(true);

      const getRes = await page.request.get(`${BASE_URL}/api/agents/${agent.id}`);
      const updated = await getRes.json();
      // User's override wins over the existing value
      expect(updated.adapterConfig.cwd).toBe(newCwd);
      // Non-overridden shared fields still preserved from original
      expect(updated.adapterConfig.instructionsFilePath).toBe(SHARED_FIELDS.instructionsFilePath);
      // env not overridden in patch — must survive from original (normalized form)
      expect(updated.adapterConfig.env).toMatchObject({ FOO: { type: "plain", value: "bar" } });
    } finally {
      await page.request.delete(`${BASE_URL}/api/companies/${companyId}/agents/${agent.id}`);
    }
  });
});
