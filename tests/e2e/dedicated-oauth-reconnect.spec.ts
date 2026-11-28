import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

test("OAuth reconnect keeps the dedicated agent and fails closed without it", async ({ page, request }) => {
  const company = await json(await request.post("/api/companies", {
    data: { name: `OAuth reconnect ${Date.now()}` },
  }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: { name: "Reconnect agent", role: "qa", adapterType: "process", adapterConfig: { command: process.execPath } },
  }));
  const connection = await json(await request.post(`/api/companies/${company.id}/tools/connections`, {
    data: {
      name: "Expired OAuth connector",
      transport: "mcp_remote",
      authKind: "none",
      config: { url: "https://1.1.1.1/mcp" },
    },
  }));
  const detailUrl = `/api/tool-connections/${connection.id}`;
  const grants = await json(await request.get(`${detailUrl}/grants`));
  const startUrl = `/api/tools/oauth/${connection.id}/start`;
  const requests: unknown[] = [];
  let retainAgent = true;
  await page.route(`**${detailUrl}`, (route) => route.fulfill({ json: {
    ...connection, authKind: "oauth", credentialPolicy: "per_agent", requiresReauthorization: true,
  } }));
  await page.route(`**${detailUrl}/grants`, (route) => route.fulfill({ json: {
    ...grants,
    grants: retainAgent ? [{
      id: "revoked-grant", kind: "agent", subjectAgentId: agent.id, status: "revoked",
      scopes: [], delegations: [], members: [],
    }] : [],
  } }));
  await page.route(`**${startUrl}`, async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 409, json: { error: "Provider is not used in this test." } });
  });

  await page.goto(`/${company.issuePrefix}/apps/${connection.id}/permissions`);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => requests).toEqual([{ asAgentId: agent.id }]);

  retainAgent = false;
  await page.reload();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.getByText("The dedicated agent identity could not be found. Reload the page to try again.")).toBeVisible();
  expect(requests).toEqual([{ asAgentId: agent.id }]);
});
