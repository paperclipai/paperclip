import { expect, test } from "@playwright/test";
import { fulfill, seedCompanyAndAgent } from "./chat-adapters-ui.shared";

// Real browser and application shell; provider authorization and chat API are
// deterministic fixtures. This never contacts X or publishes a public post.
test("X setup resumes drafts, separates bot and human authorization, and permits finishing without a test", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const seed = await seedCompanyAndAgent(request);
  const endpoint = {
    id: "endpoint-x",
    companyId: seed.companyId,
    provider: "x",
    status: "draft",
    assignedAgentId: seed.agentId,
    assignedAgentName: "Maya",
    publicationMode: "explicit",
    allowUnlinkedPeople: false,
    allowDirectMessages: false,
    botUsername: null as string | null,
    botExternalId: null as string | null,
    providerAccountId: null as string | null,
    botLabel: "Maya",
    resources: [],
    identityLinks: [],
    capabilities: { threads: true },
    setup: {
      step: "provider_setup",
      x: { stage: 1, clientConfigured: false },
      webhookUrl: `https://paperclip.example/api/chat-webhooks/${"a".repeat(43)}/x`,
      webhookVerifiedAt: null as string | null,
    },
  };
  let created = false;
  let linked = false;
  let finishCount = 0;
  const authorizationPurposes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const data = req.method() === "GET" ? {} : (req.postDataJSON() ?? {});
    if (path === "/api/instance/settings/experimental")
      return fulfill(route, { enableChatConnectors: true });
    if (path === `/api/companies/${seed.companyId}/chat-endpoints`) {
      if (req.method() === "POST") {
        expect(data).toEqual({ provider: "x", assignedAgentId: seed.agentId });
        created = true;
        return fulfill(route, endpoint, 201);
      }
      return fulfill(route, created ? [endpoint] : []);
    }
    if (path === "/api/chat-endpoints/endpoint-x") {
      if (req.method() === "PATCH")
        endpoint.allowUnlinkedPeople = data.allowUnlinkedPeople;
      return fulfill(route, endpoint);
    }
    if (path === "/api/chat-endpoints/endpoint-x/x/progress") {
      endpoint.setup.x.stage = data.stage;
      return fulfill(route, endpoint);
    }
    if (path === "/api/chat-endpoints/endpoint-x/x/authorize") {
      if (data.client) {
        expect(data.client.clientId).toBe("opaque-X-client-id");
        endpoint.setup.x.clientConfigured = true;
      } else {
        authorizationPurposes.push(data.purpose);
        if (data.purpose === "bot") {
          endpoint.status = "verifying";
          endpoint.botUsername = "mayabot";
          endpoint.botExternalId = "100";
          endpoint.providerAccountId = "100";
          endpoint.setup.step = "test";
          endpoint.setup.x.stage = 3;
        }
      }
      return fulfill(route, {
        url: `/${seed.prefix}/apps/chat/connect?provider=x&resume=endpoint-x${data.purpose === "identity" ? "&confirmation=identity-confirmation" : ""}`,
      });
    }
    if (path === "/api/chat-endpoints/endpoint-x/x/identity")
      return fulfill(route, { linked });
    if (path === "/api/x/identity/identity-confirmation")
      return fulfill(route, {
        endpointId: endpoint.id,
        identity: { id: "200", username: "personal", name: "Personal account" },
      });
    if (path === "/api/x/identity/identity-confirmation/confirm") {
      linked = true;
      return fulfill(route, { endpointId: endpoint.id });
    }
    if (path === "/api/chat-endpoints/endpoint-x/test-status")
      return fulfill(route, { messageReceivedAt: null });
    if (path === "/api/chat-endpoints/endpoint-x/x/finish") {
      expect(linked).toBe(true);
      finishCount++;
      endpoint.status = "active";
      return fulfill(route, endpoint);
    }
    if (path.startsWith("/api/chat-endpoints/endpoint-x/"))
      return fulfill(route, []);
    return route.fallback();
  });
  await page.goto(`/${seed.prefix}/apps/chat/connect?provider=x`);
  await expect(
    page.getByRole("heading", { name: "Choose agent", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select agent…", exact: true })
    .click();
  await page.getByRole("button", { name: "Select Maya", exact: true }).click();
  await page.getByRole("button", { name: "Save & exit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`));
  expect(created).toBe(true);
  await page.goto(
    `/${seed.prefix}/apps/chat/connect?provider=x&resume=endpoint-x`,
  );
  await expect(
    page.getByRole("heading", { name: "Configure X app", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save & exit", exact: true }).click();
  await page.goto(
    `/${seed.prefix}/apps/chat/connect?provider=x&resume=endpoint-x`,
  );
  await expect(
    page.getByRole("heading", { name: "Configure X app", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("OAuth callback URL")).toHaveValue(
    "https://paperclip.example/api/x/oauth/callback",
  );
  await expect(page.getByText(/prior written approval/)).toBeVisible();
  await page
    .getByLabel("OAuth 2.0 Client ID", { exact: true })
    .fill("opaque-X-client-id");
  await page
    .getByLabel("OAuth 2.0 Client Secret", { exact: true })
    .fill("fixture-secret");
  await page.getByRole("button", { name: "Save & exit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${seed.prefix}/apps$`));
  expect(endpoint.setup.x.clientConfigured).toBe(true);
  await page.goto(
    `/${seed.prefix}/apps/chat/connect?provider=x&resume=endpoint-x`,
  );
  await expect(
    page.getByText(
      "X app credentials are saved. Leave these fields blank to keep them.",
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("OAuth 2.0 Client Secret", { exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Save app & continue" }).click();
  await page
    .getByRole("button", { name: "Authorize bot account on X" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configure delivery", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  endpoint.setup.webhookVerifiedAt = new Date().toISOString();
  await page.reload();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Link your account", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Link my X account" }).click();
  await expect(
    page.getByText("Confirm that @personal is your X account."),
  ).toBeVisible();
  expect(linked).toBe(false);
  await page.getByRole("button", { name: "Confirm my X account" }).click();
  await expect(
    page.getByRole("heading", { name: "Try it", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Who can start work?")).toHaveValue("linked");
  await expect(
    page.getByText("No test message received yet. This test is optional."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/apps\/chat\/endpoint-x\/settings$/);
  expect(finishCount).toBe(1);
  expect(authorizationPurposes).toEqual(["bot", "identity"]);
  await expect(
    page.getByText("Allow direct messages", { exact: true }),
  ).toHaveCount(0);
});
