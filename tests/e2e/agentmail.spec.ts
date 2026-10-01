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
  let connected = false;
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
    fulfill(route, { enableChatConnectors: true }),
  );
  await page.route("**/api/**/email/**", async (route) => {
    const url = new URL(route.request().url()),
      method = route.request().method();
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
      return fulfill(route, connected ? [inbox] : []);
    if (url.pathname.endsWith("/inboxes") && method === "POST") {
      const body = route.request().postDataJSON();
      expect(body.receiveMode).toBe("websocket");
      expect(body.assignedAgentId).toBe(agent.id);
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
      botExternalId: inbox.address,
    }),
  );
  await page.goto(
    `/${company.issuePrefix}/apps/chat/connect?provider=agentmail&connectionId=${inbox.connectionId}`,
  );
  await expect(
    page.getByRole("heading", { name: "Give an agent an email address" }),
  ).toBeVisible();
  await page.getByRole("combobox").click();
  await page.getByPlaceholder("Search all agents…").fill("Mail agent");
  await page.getByRole("option", { name: "Mail agent" }).click();
  await expect(
    page.getByText("Mail agent is not a low-trust agent"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Configure low trust" }).click();
  const trustDialog = page.getByRole("dialog");
  await trustDialog
    .getByRole("combobox")
    .first()
    .selectOption("low_trust_review");
  await trustDialog.getByRole("combobox").nth(1).selectOption("root_issue");
  await trustDialog.getByRole("combobox").nth(2).selectOption(task.id);
  await trustDialog
    .getByRole("button", { name: "Save trust settings" })
    .click();
  await expect(page.getByText("Low-trust review configured")).toBeVisible();
  await page.getByRole("button", { name: "Review trust settings" }).click();
  await page.getByRole("dialog").getByRole("combobox").first().selectOption("standard");
  await page.getByRole("button", { name: "Save trust settings" }).click();
  await expect(page.getByText("Mail agent is not a low-trust agent")).toBeVisible();
  const savedAgent = await (await request.get(`/api/agents/${agent.id}`)).json();
  expect(savedAgent.permissions.authorizationPolicy).toEqual({});
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Advanced options", { exact: true }).click();
  await expect(
    page
      .getByLabel("Domain", { exact: true })
      .locator("option", { hasText: "verified.example.test" }),
  ).toHaveCount(1);
  await page.getByRole("radio", { name: "Use an existing inbox" }).click();
  await page.getByLabel("Available inbox").selectOption(inbox.address);
  await page.getByRole("button", { name: "Review email address" }).click();
  await expect(
    page.getByText("Anyone can email an unrestricted inbox"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Set up allowlists ↗" }),
  ).toHaveAttribute(
    "href",
    "https://docs.agentmail.to/knowledge-base/allowlists-blocklists",
  );
  await page
    .getByRole("button", { name: "Connect email address", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your agent’s email is ready" }),
  ).toBeVisible();
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
