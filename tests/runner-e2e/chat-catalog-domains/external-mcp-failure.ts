import { expect, type Page } from "@playwright/test";
import type { ToolConnection } from "../../../packages/shared/src/types/tool-access.js";
import {
  definition,
  externalObservation,
  observeExternal,
  root,
  checks,
  verifyRenderedReply,
} from "./external-support.js";
import { startNotesProvider } from "./external-provider.js";
import { waitForReply } from "./identity-support.js";
/** Follow the actual catalog card rather than an unqualified route that the
 * product intentionally redirects to Browse. No direct /byo navigation fallback. */
export async function enterGenericMcpThroughCatalog(
  page: Page,
  prefix: string,
) {
  await page.getByRole("link", { name: "Connectors", exact: true }).click();
  const card = page
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", {
        name: "Connect your own tool",
        exact: true,
      }),
    });
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await card
    .getByRole("button", { name: "Connect your own MCP server" })
    .click();
  await page.waitForURL((url) => url.pathname === `/${prefix}/apps/byo`);
}
export function gradeUnreachableMcp(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "complete-unreachable-server-evidence",
    !!o,
    "An actual unavailable fixture endpoint, rejected public setup request and visible recovery controls are required.",
  );
  if (!o) return c.result();
  c.add(
    "actual-unavailable-fixture",
    o.state.fixtureServerClosed === true &&
      typeof o.state.serverUrl === "string" &&
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(o.state.serverUrl),
    "The supplied synthetic endpoint is closed before the human query; it is not a mocked provider error.",
  );
  c.add(
    "supported-setup-failed-visibly",
    [400, 403, 422, 502, 503].includes(Number(o.state.setupStatus)) &&
      o.state.visibleConnectivityError === true &&
      o.state.checkAgainAvailable === true &&
      o.state.genericEntryThroughVisibleCatalog === true,
    "The real setup endpoint rejects connectivity or destination policy and renders an actionable error.",
  );
  c.add(
    "safe-editable-choice-preserved",
    o.state.displayedServerPreserved === true &&
      o.state.editableUrlPreserved === true &&
      o.state.abandonedDraft === true,
    "The person can return to the exact safe address, edit it and abandon the unfinished setup.",
  );
  c.add(
    "no-usable-phantom-connection",
    !o.connections.some((row) => row.status === "active") &&
      o.state.noUnexpectedConnection === true,
    "Failed setup leaves no healthy or unexpected substitute connection.",
  );
  c.add(
    "no-false-connected-claim",
    /mcp|server|connect/i.test(o.reply) &&
      !/\bI (?:have )?(?:connected|installed|enabled)\b|\b(?:is|now|already) (?:connected|healthy|ready to use)\b/i.test(
        o.reply,
      ),
    "Chat does not label the unavailable server healthy or silently substitute a different destination.",
  );
  return c.result();
}
export const mcpFailureExternalCases = [
  definition(
    "connection-setup.unreachable-mcp",
    async (ctx) => {
      const server = await startNotesProvider(
        "Never served by the closed fixture",
      );
      const serverUrl = server.url;
      await server.close();
      const before = await ctx.input.api.get<{ connections: unknown[] }>(
        `${root(ctx)}/tools/connections`,
      );
      if (before.connections.length)
        throw new Error(
          "Unavailable server journey requires an empty disposable connection catalog",
        );
      await ctx.input.api.post(
        `${root(ctx)}/chats/${ctx.input.fixtures.agent.id}`,
      );
      await ctx.refreshIssue();
      await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, {
        description: `The supplied synthetic generic MCP server URL is ${serverUrl}. No credential has been supplied.`,
      });
      return { serverUrl, fixtureServerClosed: true };
    },
    gradeUnreachableMcp,
    {
      sourceFiles: [
        "../../ui/src/App.tsx",
        "../../ui/src/pages/apps/Browse.tsx",
        "../../ui/src/features/connections/ConnectionSetupFlow.tsx",
        "../../ui/src/pages/apps/app-connect-policy.ts",
        "chat-catalog-domains/external-mcp-failure.ts",
        "chat-catalog-domains/external-provider.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-catalog-domains/identity-support.ts",
        "chat-scenarios/connection-setup.yaml",
      ],
      async act(ctx, state) {
        await waitForReply(ctx);
        const source = ctx.input.page.url();
        await enterGenericMcpThroughCatalog(
          ctx.input.page,
          String(ctx.input.fixtures.company.issuePrefix),
        );
        state.genericEntryThroughVisibleCatalog = true;
        const url = ctx.input.page.getByRole("textbox", {
          name: "MCP server URL",
          exact: true,
        });
        await url.fill(String(state.serverUrl));
        await ctx.input.page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        const checked = ctx.input.page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
              `${root(ctx)}/tools/apps/connect` &&
            response.request().method() === "POST",
        );
        await ctx.input.page
          .getByRole("button", { name: "Check link", exact: true })
          .click();
        state.setupStatus = (await checked).status();
        const error = ctx.input.page
          .getByRole("note")
          .filter({
            hasText:
              /couldn.t (?:reach|connect)|private network|couldn.t find that host/i,
          });
        await expect(error).toBeVisible();
        state.visibleConnectivityError = true;
        await expect(
          ctx.input.page.getByRole("button", {
            name: "Check link",
            exact: true,
          }),
        ).toBeEnabled();
        state.checkAgainAvailable = true;
        await expect(
          ctx.input.page.getByText(String(state.serverUrl), { exact: true }),
        ).toBeVisible();
        state.displayedServerPreserved = true;
        await ctx.input.page
          .getByRole("button", { name: "Back", exact: true })
          .click();
        await expect(url).toHaveValue(String(state.serverUrl));
        await url.fill(String(state.serverUrl) + "corrected");
        state.editableUrlPreserved =
          (await url.inputValue()) === String(state.serverUrl) + "corrected";
        await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
        state.abandonedDraft = true;
        await ctx.input.evidence("chat-catalog-unreachable-mcp.json", {
          setupStatus: state.setupStatus,
          visibleConnectivityError: true,
          editableUrlPreserved: state.editableUrlPreserved,
          abandonedDraft: true,
        });
      },
      async observe(ctx, state) {
        const rows = await ctx.input.api.get<{ connections: ToolConnection[] }>(
          `${root(ctx)}/tools/connections`,
        );
        state.noUnexpectedConnection = rows.connections.every(
          (row) =>
            row.config?.url === state.serverUrl && row.status !== "active",
        );
        return observeExternal(ctx, state);
      },
      async verifyResult(ctx, _state, value) {
        await verifyRenderedReply(ctx, value);
      },
      async cleanup(ctx) {
        const rows = await ctx.input.api.get<{
          connections: Array<{ id: string }>;
        }>(`${root(ctx)}/tools/connections`);
        for (const row of rows.connections)
          await ctx.input.api.delete(`/api/tool-connections/${row.id}`, {
            allowNotFound: true,
          });
      },
    },
  ),
];
