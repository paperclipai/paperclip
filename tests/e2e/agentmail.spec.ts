import { randomUUID } from "node:crypto";
import { test, expect, type Route } from "@playwright/test";

const fulfill = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

test("AgentMail setup and email work through the normal task conversation", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  const settings = await request.patch("/api/instance/settings/experimental", {
    data: { enableChatConnectors: false },
  });
  expect(settings.ok()).toBeTruthy();
  const created = await request.post("/api/companies", {
    data: { name: `AgentMail browser ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const company = await created.json();
  const agentResponse = await request.post(
    `/api/companies/${company.id}/agents`,
    {
      data: {
        name: "Mail agent",
        role: "qa",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      },
    },
  );
  expect(agentResponse.ok()).toBeTruthy();
  const agent = await agentResponse.json();
  const taskResponse = await request.post(
    `/api/companies/${company.id}/issues`,
    { data: { title: "Customer email", status: "backlog" } },
  );
  expect(taskResponse.ok()).toBeTruthy();
  const task = await taskResponse.json();
  const inbox = {
    id: randomUUID(),
    companyId: company.id,
    connectionId: randomUUID(),
    assignedAgentId: agent.id,
    address: "agent@agentmail.to",
    status: "active",
    receiveMode: "websocket",
    lastError: null,
    lastSyncAt: new Date().toISOString(),
  };
  const organizationConnectionId = randomUUID();
  let connected = false;
  let reservedInbox: typeof inbox | null = null;
  const setupRequests: { idempotencyKey: string; username?: string }[] = [];
  const addressTakenError = "This email address is already in use. Choose a different address.";
  const permissionError = "AgentMail did not allow Paperclip to create an inbox-scoped API key. Check your API key permissions and AgentMail account limits, then try again.";
  const sends: any[] = [];
  const conversationId = randomUUID();
  const thread = {
    conversationId,
    issueId: task.id,
    endpoint: inbox,
    subject: "Customer email",
    messages: [
      {
        id: randomUUID(),
        providerMessageId: "incoming-message",
        from: "Customer <customer@example.test>",
        to: [inbox.address],
        cc: ["visible@example.test"],
        bcc: ["private@example.test"],
        subject: "Customer email",
        direction: "inbound",
        text: "Can you help?",
        fullText: "Can you help?\nEarlier quoted context",
        commentId: null,
        attachmentIds: [],
        timestamp: new Date().toISOString(),
        automatic: false,
      },
    ],
    publications: [] as any[],
  };
  await page.route("**/api/instance/settings/experimental", (route) =>
    fulfill(route, { enableChatConnectors: false }),
  );
  await page.route(`**/api/companies/${company.id}/tools/connections`, route =>
    fulfill(route, { connections: [{
      id: organizationConnectionId, name: "AgentMail", status: "active", enabled: true,
      config: { provider: "agentmail", emailCredential: true }, createdAt: "2026-09-30T14:00:00Z",
    }] }),
  );
  await page.route(`**/api/companies/${company.id}/chat-endpoints`, route =>
    fulfill(route, reservedInbox ? [{ ...reservedInbox, provider: "agentmail", assignedAgentName: agent.name,
      providerAccountLabel: reservedInbox.address }] : []),
  );
  await page.route(`**/api/tool-connections/${inbox.connectionId}`, route =>
    fulfill(route, { config: { credentialConnectionId: organizationConnectionId } }),
  );
  await page.route(`**/api/tool-connections/${organizationConnectionId}/grants`, route =>
    fulfill(route, { grants: [{ status: "active", kind: "organization" }], capabilities: { canConfigure: true } }),
  );
  await page.route(`**/api/tool-connections/${organizationConnectionId}/installs`, route =>
    fulfill(route, { installs: [{ targetType: "agent", targetId: agent.id }] }),
  );
  await page.route(`**/api/chat-endpoints/${inbox.id}/conversations`, route =>
    fulfill(route, [{ id: conversationId, externalLabel: "Customer email", issueId: task.id,
      issueTitle: task.title, issueIdentifier: task.identifier, state: "active" }]),
  );
  await page.route(`**/api/chat-endpoints/${inbox.id}/activity?*`, route =>
    fulfill(route, { items: [{ id: randomUUID(), kind: "delivery", status: "processed",
      summary: "Email received", createdAt: new Date().toISOString() }], nextCursor: null }),
  );
  await page.route("**/api/**/email/**", async (route) => {
    const url = new URL(route.request().url()),
      method = route.request().method();
    if (url.pathname.endsWith("/connections") && method === "GET") return fulfill(route, [
      { id: organizationConnectionId, label: "AgentMail account key", scope: "organization", createdAt: "2026-09-30T14:00:00Z" },
      { id: inbox.connectionId, label: "AgentMail inbox key", scope: "inbox", createdAt: "2026-10-01T14:00:00Z" },
    ]);
    if (url.pathname.endsWith("/connections") && method === "POST") {
      expect(route.request().postDataJSON()).toMatchObject({ apiKey: "inbox-test-key", agentIds: [agent.id], allAgents: false });
      return fulfill(route, { id: inbox.connectionId }, 201);
    }
    if (url.pathname.endsWith("/check-address")) {
      const body = route.request().postDataJSON();
      return fulfill(route, { address: `${body.username}@${body.domain}`, status: body.username === "taken" ? "taken" : "unknown" });
    }
    if (url.pathname.endsWith(`/connections/${inbox.connectionId}/inspect`))
      return fulfill(route, {
        scope: { scope_type: "inbox" }, inboxes: [{ inbox_id: inbox.address }], domains: [],
      });
    if (url.pathname.endsWith("/inspect"))
      return fulfill(route, {
        scope: { scope_type: "organization" },
        inboxes: [{ inbox_id: inbox.address }],
        domains: [
          {
            domain_id: "domain-id",
            domain: "verified.example.test",
            status: "VERIFIED",
          },
        ],
      });
    if (url.pathname.endsWith("/inboxes") && method === "GET")
      return fulfill(route, connected ? [inbox] : reservedInbox ? [reservedInbox] : []);
    if (url.pathname.endsWith("/inboxes") && method === "POST") {
      const body = route.request().postDataJSON();
      expect(body.receiveMode).toBe("websocket");
      expect(body.assignedAgentId).toBe(agent.id);
      expect(body.credentialConnectionId).toBe(organizationConnectionId);
      setupRequests.push(body);
      if (setupRequests.length === 1) return fulfill(route, { error: addressTakenError, code: "agentmail_address_taken",
        details: { field: "username", providerStatus: 403, operation: "create_inbox" } }, 409);
      if (setupRequests.length === 2) {
        reservedInbox = { ...inbox, id: body.idempotencyKey, address: `${body.username}@${body.domain}`, status: "draft" };
        return fulfill(route, {
          error: permissionError,
          details: { code: "agentmail_request_failed", providerStatus: 403, operation: "create_inbox_key" },
        }, 422);
      }
      connected = true;
      return fulfill(route, inbox, 201);
    }
    if (url.pathname.endsWith(`/tasks/${task.id}`))
      return fulfill(route, thread);
    if (url.pathname.endsWith("/send")) {
      const input = route.request().postDataJSON();
      sends.push(input);
      const publication = {
        id: input.idempotencyKey,
        issueId: input.parentIssueId ? randomUUID() : task.id,
        conversationId,
        outcome: "queued",
        error: null,
        providerMessageId: null,
      };
      thread.publications.push(publication);
      return fulfill(route, publication, 202);
    }
    return fulfill(route, null);
  });
  await page.route(`**/api/chat-endpoints/${inbox.id}`, (route) =>
    fulfill(route, {
      ...inbox,
      provider: "agentmail",
      setup: { step: "complete" },
      capabilities: {},
      assignedAgentName: agent.name,
      botExternalId: inbox.address,
    }),
  );
  await page.goto(`/${company.issuePrefix}/apps`);
  await page.getByRole("button", { name: /^(Connect|Add connection) AgentMail$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Give an agent an email address" }),
  ).toBeVisible();
  await page.getByLabel("Agent", { exact: true }).click();
  await page.getByPlaceholder("Filter agents").fill("Mail agent");
  await expect(page.getByRole("button", { name: "Select Mail agent", exact: true }).locator('[data-slot="agent-avatar"]')).toBeVisible();
  await page.getByRole("button", { name: "Select Mail agent", exact: true }).click();
  await expect(page.locator('#email-agent [data-slot="agent-avatar"]')).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue(organizationConnectionId);
  // A deliberately selected restricted key stays at credentials until the user
  // chooses a usable account key or explicitly requests that existing inbox.
  await page.getByLabel("API key", { exact: true }).selectOption(inbox.connectionId);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText(`That key only connects ${inbox.address}.`, { exact: false })).toBeVisible();
  await expect(page.getByLabel("Mail agent’s email address", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("agentmail-inbox-key-recovery.png"), fullPage: true });
  await page.getByLabel("API key", { exact: true }).selectOption(organizationConnectionId);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const addressField = page.getByLabel("Mail agent’s email address", { exact: true });
  await expect(addressField).toBeEditable();
  await expect(page.getByRole("heading", { name: "How it Works", exact: true })).toBeVisible();
  await expect(page.getByLabel("Email domain", { exact: true })).toHaveValue("verified.example.test");
  await page.getByLabel("Email domain", { exact: true }).selectOption("agentmail.to");
  await expect(page.getByLabel("Email domain", { exact: true })).toHaveValue("agentmail.to");
  await page.getByLabel("Email domain", { exact: true }).selectOption("verified.example.test");
  await addressField.fill("taken");
  await expect(page.getByRole("alert")).toHaveText(addressTakenError);
  expect(setupRequests).toHaveLength(0);
  await page.getByRole("button", { name: "taken-agent@verified.example.test", exact: true }).click();
  await expect(addressField).toHaveValue("taken-agent");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await addressField.fill("mail-agent");
  await expect(page.getByRole("button", { name: "Review email address" })).toHaveCount(0);
  await page.getByText("Advanced options", { exact: true }).click();
  await expect(page.getByLabel("Email domain", { exact: true }).locator("option", { hasText: "verified.example.test" })).toHaveCount(1);
  await page.getByRole("button", { name: "Review trust settings" }).click();
  const trustDialog = page.getByRole("dialog");
  await trustDialog.getByRole("combobox").first().selectOption("low_trust_review");
  await trustDialog.getByRole("combobox").nth(1).selectOption("root_issue");
  await trustDialog.getByRole("combobox").nth(2).selectOption(task.id);
  await trustDialog.getByRole("button", { name: "Save trust settings" }).click();
  await expect(page.getByText("Low-trust review configured")).toBeVisible();
  await page.getByRole("button", { name: "Review trust settings" }).click();
  await page.getByRole("dialog").getByRole("combobox").first().selectOption("standard");
  await page.getByRole("button", { name: "Save trust settings" }).click();
  await expect(trustDialog).not.toBeVisible();
  const savedAgent = await (await request.get(`/api/agents/${agent.id}`)).json();
  expect(savedAgent.permissions.authorizationPolicy).toEqual({});
  await expect(page.getByRole("link", { name: "Set up allowlists ↗" })).toHaveAttribute(
    "href", "https://docs.agentmail.to/knowledge-base/allowlists-blocklists");
  await page.getByText("Advanced options", { exact: true }).click();
  await page.getByRole("button", { name: "Create email address", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(addressTakenError);
  await expect(addressField).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Create email address", exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("agentmail-address-taken.png"), fullPage: true });
  await addressField.fill("mail-agent-free");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(addressField).toHaveValue("mail-agent-free");
  await page.getByRole("button", { name: "Create email address", exact: true }).click();
  await expect(page.getByText(permissionError, { exact: true })).toBeVisible();
  await expect(page.getByText("Internal server error", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your agent’s email is ready" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("agentmail-permission-denied.png"), fullPage: true });
  await page.getByRole("link", { name: "Connectors", exact: true }).click();
  await page.getByRole("button", { name: "Finish setup", exact: true }).click();
  await expect(page.getByText("mail-agent-free@verified.example.test", { exact: true })).toBeVisible();
  await expect(addressField).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose a different address", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Finish connecting", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your agent’s email is ready" })).toBeVisible();
  expect(setupRequests.map(input => input.username)).toEqual(["mail-agent", "mail-agent-free", undefined]);
  expect(setupRequests[2]).toMatchObject({ inboxId: "mail-agent-free@verified.example.test" });
  expect(new Set(setupRequests.map(input => input.idempotencyKey)).size).toBe(1);
  await page.getByRole("button", { name: "Email settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: inbox.address, exact: true })).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Chat connection" });
  await navigation.getByRole("link", { name: "Access", exact: true }).click();
  await expect(page.getByText("Any human in the organization", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect inbox", exact: true })).toHaveCount(0);
  await navigation.getByRole("link", { name: "Conversations", exact: true }).click();
  await expect(page.getByRole("list", { name: "Conversations" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Conversations" }).locator(`a[href="/${company.issuePrefix}/issues/${task.id}"]`)).toHaveAttribute("href", `/${company.issuePrefix}/issues/${task.id}`);
  await page.reload();
  await expect(page.getByRole("list", { name: "Conversations" })).toBeVisible();
  await navigation.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByText("Email received", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connection activity", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("agentmail-management-tabs.png"), fullPage: true });
  await navigation.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Receiving email", exact: true })).toBeVisible();
  const copyAddress = page.getByRole("button", { name: "Copy email address", exact: true });
  await expect(copyAddress).toHaveText(inbox.address);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await copyAddress.click();
  await expect(page.getByRole("status").filter({ hasText: "Copied!" })).toHaveCSS("opacity", "1");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(inbox.address);
  await expect(page.getByRole("link", { name: "View inbox", exact: true })).toHaveAttribute(
    "href", `https://console.agentmail.to/dashboard/inboxes/${encodeURIComponent(inbox.address)}`);
  await page.screenshot({ path: test.info().outputPath("agentmail-settings-copy-inbox.png"), fullPage: true });
  await expect(page.getByLabel("New API key", { exact: true })).not.toBeVisible();
  await page.locator("summary").filter({ hasText: "Reconnect inbox" }).click();
  await expect(page.getByLabel("New API key", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect inbox", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("agentmail-settings-reconnect.png"), fullPage: true });
  await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
  const email = page.getByRole("article", { name: "Email received", exact: true });
  await expect(email).toBeVisible();
  await expect(email.getByText("Can you help?", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", {
    name: /^(Internal comment|Email reply|Start email child task)$/,
  })).toHaveCount(0);
  await expect(email.getByText("Bcc: private@example.test")).not.toBeVisible();
  await email.getByText("Email details", { exact: true }).click();
  await expect(email.getByText("Bcc: private@example.test")).toBeVisible();

  const composer = page.locator('[contenteditable="true"]').last();
  await expect(composer).toBeEditable();
  const instruction = "Please reply to the customer and confirm Friday delivery.";
  await composer.fill(instruction);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => {
    const comments = await (await request.get(`/api/issues/${task.id}/comments`)).json();
    return comments.some((comment: { body: string }) => comment.body.includes(instruction));
  }).toBe(true);
  // Task instructions persist normally; only an explicit agent action sends mail.
  expect(sends).toHaveLength(0);
  await page.screenshot({
    path: test.info().outputPath("email-task-conversation.png"),
    fullPage: true,
  });
});
