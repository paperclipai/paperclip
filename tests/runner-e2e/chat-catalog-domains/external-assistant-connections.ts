import {
  chatgptSetupCase,
  gradeChatgptSetup,
} from "./external-chatgpt-setup.js";
import { expect } from "@playwright/test";
import type {
  McpConnection,
  McpConnectionSetup,
} from "../../../packages/shared/src/public-mcp.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import {
  definition,
  externalObservation,
  observeExternal,
  root,
  checks,
} from "./external-support.js";
import { waitForReply } from "./identity-support.js";
import {
  beginConnection,
  connect,
  mcp,
  origin,
  type Tokens,
} from "../public-mcp-client.js";

const requests = new WeakMap<
  ChatCatalogContext,
  Awaited<ReturnType<typeof beginConnection>>
>();
const grants = new WeakMap<ChatCatalogContext, { tokens: Tokens }>();
export async function prepareAssistantSetup(ctx: ChatCatalogContext) {
  if (origin !== ctx.input.api.baseURL)
    throw new Error(
      "Public MCP fixture origin differs from the disposable server",
    );
  if (!ctx.input.privateSecrets)
    throw new Error("Public MCP requires the attempt-private redaction sink");
  await ctx.input.api.patch("/api/instance/settings/experimental", {
    enablePublicMcp: true,
  });
  const setup = await ctx.input.api.get<McpConnectionSetup>("/api/mcp/setup");
  if (!setup.enabled || new URL(setup.serverUrl).origin !== origin)
    throw new Error(
      "Setup blocker: authenticated public MCP issuer/resource is not configured for this disposable server",
    );
  return setup;
}
export function gradeAssistantSetup(value: unknown) {
  const c = checks();
  const o = externalObservation(value);
  c.add(
    "complete-assistant-evidence",
    !!o,
    "Current setup metadata, actual signed-in consent and grant observations are required.",
  );
  if (!o) return c.result();
  if (o.scenarioId === "assistant-connections.connect-external-assistant") {
    return gradeChatgptSetup(value);
  } else if (o.scenarioId === "assistant-connections.decline-consent") {
    c.add(
      "actual-human-denied-request",
      o.state.consentVisible === true &&
        o.state.callbackError === "access_denied" &&
        o.state.callbackStateMatched === true &&
        o.state.newGrantCount === 0,
      "The real consent Cancel action denies this request and returns its original OAuth state.",
    );
    c.add(
      "unrelated-grant-preserved",
      o.state.otherGrantBefore === o.state.otherGrantAfter &&
        o.state.otherGrantStillUsable === true,
      "Declining one authorization preserves the unrelated real grant and its access.",
    );
    // Graded from saved state, never from reply wording: the reply cannot be
    // checked for a false success claim without a keyword list.
    c.add(
      "chat-replied",
      o.phaseReplies.some((row) => row.body.trim().length > 0),
      "Chat answered the person in this conversation.",
    );
    c.add(
      "no-duplicate-consent-prompt",
      !o.interactions.some((row) => row.status === "pending"),
      "Chat leaves no pending prompt asking the person to decide again.",
    );
    c.add(
      "agent-changed-no-connection",
      !o.activity.some(
        (row) =>
          row.actorType === "agent" &&
          (/^(?:mcp|connection|tool|secret|oauth)[._]/.test(String(row.action)) ||
            /connection|grant|secret/.test(String((row as { entityType?: unknown }).entityType ?? ""))),
      ),
      "The agent made no connection, grant or secret write of its own.",
    );
  } else
    c.add(
      "known-assistant-scenario",
      false,
      "A case-specific assistant oracle is required.",
    );
  return c.result();
}
export const assistantConnectionExternalCases = [
  chatgptSetupCase,
  definition(
    "assistant-connections.decline-consent",
    async (ctx) => {
      await prepareAssistantSetup(ctx);
      const source = ctx.input.page.url();
      const other = await connect(
        ctx.input.page.context(),
        {
          ...ctx.input.fixtures.company,
          issuePrefix: ctx.input.fixtures.company.issuePrefix ?? "EVAL",
        },
        false,
        ctx.input.page,
        ctx.input.privateSecrets!,
      );
      grants.set(ctx, other);
      const before = await ctx.input.api.get<McpConnection[]>(
        "/api/mcp/connections",
      );
      const request = await beginConnection(true);
      requests.set(ctx, request);
      // OAuth state is a CSRF nonce the server must store to echo on the
      // redirect (mcp_oauth_requests.state), not a credential. Keep it out of
      // the persisted-state secret scan; the verifier is never sent or stored.
      ctx.input.privateSecrets!.push(request.verifier);
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
      return {
        otherGrantId: before[0]?.id,
        otherGrantBefore: JSON.stringify(before[0]),
        requestId: request.requestId,
      };
    },
    gradeAssistantSetup,
    {
      authentication: "human-session",
      oracleVersion: "paperclip.chat-catalog.external-decline-consent.v2",
      sourceFiles: [
        "chat-catalog-domains/external-assistant-connections.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-catalog-domains/identity-support.ts",
        "public-mcp-client.ts",
        "chat-scenarios/assistant-connections.yaml",
      ],
      async act(ctx, state) {
        await waitForReply(ctx);
        const request = requests.get(ctx);
        if (!request) throw new Error("Pending authorization fixture missing");
        const source = ctx.input.page.url();
        await ctx.input.page.goto(request.consentUrl);
        await expect(
          ctx.input.page.getByRole("heading", {
            name: /^Connect .+ to Paperclip$/,
          }),
        ).toBeVisible();
        await ctx.input.page
          .getByRole("radio", {
            name: ctx.input.fixtures.company.name,
            exact: true,
          })
          .check();
        state.consentVisible = true;
        await ctx.input.page
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await ctx.input.page.waitForURL((url) => url.searchParams.has("error"));
        const callback = new URL(ctx.input.page.url());
        state.callbackError = callback.searchParams.get("error");
        state.callbackStateMatched =
          callback.searchParams.get("state") === request.state;
        const rows = await ctx.input.api.get<McpConnection[]>(
          "/api/mcp/connections",
        );
        state.newGrantCount = rows.filter(
          (row) => row.id !== state.otherGrantId,
        ).length;
        state.otherGrantAfter = JSON.stringify(
          rows.find((row) => row.id === state.otherGrantId),
        );
        const client = await mcp(grants.get(ctx)!.tokens);
        try {
          state.otherGrantStillUsable =
            (await client.call("paperclip_connection")).structuredContent
              ?.companyId === ctx.input.fixtures.company.id;
        } finally {
          await client.close();
        }
        await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
        await expect(
          ctx.input.page.getByTestId("task-chat-composer-input"),
        ).toBeVisible();
      },
      async verifyResult(ctx) {
        await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
        await expect(
          ctx.input.page.getByTestId("task-chat-composer-input"),
        ).toBeVisible();
      },
      async cleanup(ctx) {
        for (const grant of await ctx.input.api.get<McpConnection[]>(
          "/api/mcp/connections",
        ))
          await ctx.input.api.delete(`/api/mcp/connections/${grant.id}`);
        requests.delete(ctx);
        grants.delete(ctx);
      },
    },
  ),
];
