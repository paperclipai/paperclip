import { randomBytes } from "node:crypto";
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
  authenticated?: boolean;
}) {
  const credential = input.authenticated
    ? randomBytes(32).toString("hex")
    : undefined;
  const provider = await startReviewProvider(input.marker, credential);
  try {
    const { page, api } = input;
    let connection: { id: string };
    if (credential) {
      // Setup through the public API avoids putting this fixture credential in
      // browser traces or the agent's environment. Approval remains a UI action.
      const connected = await api.postSensitive<any>(
        `/api/companies/${input.companyId}/tools/apps/connect`,
        {
          link: provider.url,
          name: "Studio Page Service",
          authMode: "bearer",
          credentialValues: { "credentials.authorization": credential },
          grantKind: "organization",
        },
      );
      const ids = [
        ...connected.actions.readOnly,
        ...connected.actions.canMakeChanges,
      ].map((a: any) => a.catalogEntryId);
      await api.post(
        `/api/companies/${input.companyId}/tools/apps/${connected.connectionId}/finish`,
        {
          enabledCatalogEntryIds: ids,
          askFirstCatalogEntryIds: ids,
          access: { agentIds: [input.agentId] },
        },
      );
      connection = { id: connected.connectionId };
    } else {
      await page.goto(`/${input.prefix}/apps`, { waitUntil: "domcontentloaded" });
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
        connections: [createdConnection],
      } = await api.get<{ connections: Array<{ id: string }> }>(
        `/api/companies/${input.companyId}/tools/connections`,
      );
      connection = createdConnection!;
    }
    const installed = await api.request.put(
      `/api/tool-connections/${connection.id}/installs`,
      {
        data: { installs: [{ targetType: "agent", targetId: input.agentId }] },
      },
    );
    expect(installed.ok()).toBe(true);
    await page.goto(`/${input.prefix}/apps/${connection.id}/permissions`, {
      waitUntil: "domcontentloaded",
    });
    const askFirst = page.getByRole("radio", {
      name: "List fixture pages: Ask first",
    });
    await expect(askFirst).toBeVisible({ timeout: 30_000 });
    await askFirst.click();
    return {
      ...provider,
      connectionId: connection.id,
      invocationCount: () =>
        provider.captures.filter(
          (call) => call.method === "tools/call" && call.authorized !== false,
        ).length,
    };
  } catch (error) {
    await provider.close();
    throw error;
  }
}
