import { expect, type Page } from "@playwright/test";
import type { RunnerApi } from "./api.js";
import { startReviewProvider } from "../fixtures/connection-review-provider.js";

/** Uses the same production connection and permission screens as the fixture browser suite. */
export async function setupConnectionReview(input: {
  page: Page;
  api: RunnerApi;
  prefix: string;
  companyId: string;
  agentId: string;
  marker: string;
}) {
  const provider = await startReviewProvider(input.marker);
  try {
    const { page, api } = input;
    await page.goto(`/${input.prefix}/apps`);
    const connector = page
      .getByRole("list", { name: "Connector list" })
      .getByRole("listitem")
      .filter({ hasText: "Connect your own tool" });
    await connector
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await connector
      .getByRole("button", { name: "Connect your own MCP server" })
      .click();
    await page
      .getByPlaceholder("https://example.com/actions")
      .fill(provider.url);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.getByRole("button", { name: /Check link/i }).click();
    await expect(
      page.getByRole("heading", { name: /is ready/i }),
    ).toBeVisible();
    const {
      connections: [connection],
    } = await api.get<{ connections: Array<{ id: string }> }>(
      `/api/companies/${input.companyId}/tools/connections`,
    );
    const installed = await api.request.put(
      `/api/tool-connections/${connection.id}/installs`,
      {
        data: { installs: [{ targetType: "agent", targetId: input.agentId }] },
      },
    );
    expect(installed.ok()).toBe(true);
    await page.goto(`/${input.prefix}/apps/${connection.id}/permissions`);
    await page
      .getByRole("radio", { name: "List fixture pages: Ask first" })
      .click();
    return {
      ...provider,
      connectionId: connection.id,
      invocationCount: () =>
        provider.captures.filter((call) => call.method === "tools/call").length,
    };
  } catch (error) {
    await provider.close();
    throw error;
  }
}
