import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type {
  McpConnection,
  McpConnectionSetup,
} from "../../../packages/shared/src/public-mcp.js";
import type {
  Issue,
  IssueComment,
} from "../../../packages/shared/src/types/issue.js";
import {
  definition,
  checks,
  root,
  observeExternal,
  externalObservation,
} from "./external-support.js";
import { runtimePrivateSpec } from "./runtime-private.js";
import {
  chatgptPublicOrigin,
  privateChatgptAvailability,
  privateChatgptSetup,
  cleanupPrivateChatgpt,
} from "./external-chatgpt.js";
import {
  setupCheckComment,
  exactAcceptedChatgptScopes,
  chatgptConsentDisclosure,
  type ChatgptReceipt,
} from "./external-chatgpt-contract.js";
import { waitForReply } from "./identity-support.js";
import { isDeepStrictEqual } from "node:util";
import type { Entity } from "./internal-support.js";
function taskIdentity(t: Issue) {
  return {
    id: t.id,
    companyId: t.companyId,
    title: t.title,
    description: t.description,
    status: t.status,
    assigneeAgentId: t.assigneeAgentId,
    assigneeUserId: t.assigneeUserId,
    responsibleUserId: t.responsibleUserId,
    projectId: t.projectId,
    parentId: t.parentId,
  };
}
async function companyNativeIds(ctx: ChatCatalogContext) {
  const rows = await ctx.input.api.getRunObservation<Array<{ id: string }>>(
    `${root(ctx)}/heartbeat-runs?limit=100`,
  );
  if (rows.length >= 100)
    throw new Error(
      "Cannot independently prove bounded complete company run inventory",
    );
  return rows.map((r) => r.id).sort();
}
export function truthfulChatgptHandoff(reply: string) {
  const falseClaim = reply.split(/[.!?;\n]+|\bbut\b/i).some((clause) => {
    const match =
      /\bI(?:['’]ve| have)?\s+(?:already\s+)?(?:connected|installed|authorized)\b|\bChatGPT\s+(?:is|has been)\s+(?:now |already )?(?:connected|installed|authorized)\b/i.exec(
        clause,
      );
    return (
      !!match &&
      !/\b(?:once|after|when|if|until|before)\b[^,]{0,80}$/i.test(
        clause.slice(0, match.index),
      )
    );
  });
  return /ChatGPT/i.test(reply) && !falseClaim;
}
export function gradeChatgptSetup(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "named-chatgpt-setup-evidence",
    !!o,
    "Actual selected human ChatGPT UI, real OAuth consent, same-grant MCP use and public state are required.",
  );
  if (!o) return c.result();
  const r = o.state.namedReceipt as ChatgptReceipt | undefined,
    rows = o.state.assistantConnections as McpConnection[] | undefined,
    grant = rows?.find((g) => g.id === r?.grantId),
    comment = o.state.controlComment as IssueComment | undefined;
  c.add(
    "supported-truthful-company-handoff",
    o.state.setupMetadataMatched === true &&
      o.state.actualBrowserInstructionsVisible === true &&
      truthfulChatgptHandoff(o.reply) &&
      o.links.some((href) => {
        try {
          const u = new URL(href, o.origin);
          return u.origin === o.origin && u.pathname === o.state.resultPath;
        } catch {
          return false;
        }
      }),
    "The canonical CEO reply points to actual company assistant instructions and does not claim ChatGPT was installed before human action.",
  );
  c.add(
    "actual-selected-named-human-ui-consent",
    o.state.operatorAvailable === true &&
      !!r &&
      r.operation === "setup" &&
      r.companyId === o.companyId &&
      r.humanId === o.state.humanId &&
      r.processIsolation === true &&
      r.testRunnerAttached === false &&
      r.tracingEnabled === false &&
      r.videoEnabled === false &&
      r.actualChatgptUi === true &&
      r.realHumanConsent === true &&
      r.actualProviderCallback === true &&
      r.boundMcpComment === true &&
      r.zeroNativeAdmissions === true &&
      chatgptConsentDisclosure(
        r.requestedScopes?.includes("paperclip:configure") === true,
        r.consentWording,
        r.configureDisclosed,
      ),
    "The selected human really uses ChatGPT's private custom-app UI and submits the actual Paperclip OAuth consent; an operator acknowledgement or generic MCP client alone is insufficient.",
  );

  c.add(
    "actual-single-named-current-person-grant",
    !!grant &&
      rows?.filter((g) => g.companyId === o.companyId && !g.revokedAt)
        .length === 1 &&
      grant.companyId === o.companyId &&
      !grant.revokedAt &&
      /^(?:ChatGPT|OpenAI|OpenAI ChatGPT)$/i.test(grant.clientName) &&
      grant.scopes.includes("paperclip:read") &&
      grant.scopes.includes("paperclip:write") &&
      exactAcceptedChatgptScopes(
        r?.requestedScopes,
        grant.scopes,
        r?.configureDisclosed,
      ) &&
      exactAcceptedChatgptScopes(
        r?.acceptedScopes,
        grant.scopes,
        r?.configureDisclosed,
      ) &&
      o.state.currentPersonPreserved === true,
    "A real single named ChatGPT grant exists for the intended company/current person with the explicitly approved scopes.",
  );
  const activity = o.activity as Array<Entity & { companyId?: string }>;
  const authorized = activity.find(
    (a) =>
      a.action === "mcp.connection_authorized" &&
      a.entityId === grant?.id &&
      a.actorType === "user" &&
      a.actorId === o.state.humanId,
  );
  const calls = activity.filter(
    (a) => a.action === "mcp.tool_called" && a.entityId === grant?.id,
  );
  c.add(
    "independent-exact-grant-comment-audit",
    !!r &&
      !!authorized &&
      calls.length === 1 &&
      calls[0]!.actorType === "user" &&
      calls[0]!.actorId === o.state.humanId &&
      typeof authorized.details?.clientId === "string" &&
      !!authorized.details.clientId &&
      exactAcceptedChatgptScopes(
        authorized.details.scopes,
        grant?.scopes,
        r.configureDisclosed,
      ) &&
      calls[0]!.details?.clientId === authorized.details?.clientId &&
      calls[0]!.details?.operation === "paperclip_add_comment" &&
      calls[0]!.details?.requestId === r.clientRequestId &&
      !!comment &&
      comment.id === r.commentId &&
      comment.issueId === o.state.controlTaskId &&
      comment.companyId === o.companyId &&
      comment.authorUserId === o.state.humanId &&
      !comment.authorAgentId &&
      !comment.createdByRunId &&
      comment.clientRequestId === r.clientRequestId &&
      setupCheckComment(comment.body, String(o.state.ownerFact)) &&
      o.state.controlCommentCount === 1,
    "Independent public audit joins the exact named client/grant/person/requestId to its one actual task-grounded comment; no surrogate REST write or wrong target can pass.",
  );
  c.add(
    "human-controlled-task-and-no-native-wake",
    o.state.controlTaskUnchanged === true &&
      o.state.noAgentAssignmentOrWatchdog === true &&
      o.state.zeroNativeAdmissions === true,
    "The owned backlog task remains human-controlled, unassigned to agents, without watchdog or mentions; actual full company run IDs prove no native admission during qualification.",
  );
  c.add(
    "company-hint-is-not-authority",
    o.state.unauthenticatedMcpStatus === 401 &&
      o.state.unauthenticatedHintDidNotGrant === true,
    "A real unauthenticated request carrying only a copied company hint receives no grant or company access.",
  );
  return c.result();
}
export const chatgptSetupCase = definition(
  "assistant-connections.connect-external-assistant",
  async (ctx) => {
    await ctx.input.api.patch("/api/instance/settings/experimental", {
      enablePublicMcp: true,
    });
    const origin = await chatgptPublicOrigin(ctx),
      setup = await ctx.input.api.get<McpConnectionSetup>("/api/mcp/setup");
    if (
      !setup.enabled ||
      setup.serverUrl !== `${origin.publicOrigin}/mcp/paperclip`
    )
      throw new Error(
        "Setup blocker: actual named ChatGPT setup does not advertise its validated owned HTTPS resource",
      );
    const availability = await privateChatgptAvailability(ctx);
    const humanId = (
      await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session")
    ).user.id;
    const before = await ctx.input.api.get<McpConnection[]>(
        "/api/mcp/connections",
      ),
      url = new URL(setup.serverUrl);
    url.searchParams.set("companyId", ctx.input.fixtures.company.id);
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { companyId: ctx.input.fixtures.company.id },
      }),
    });
    const unauthenticatedMcpStatus = response.status;
    await response.body?.cancel();
    const after = await ctx.input.api.get<McpConnection[]>(
      "/api/mcp/connections",
    );
    if (
      before.some(
        (g) => g.companyId === ctx.input.fixtures.company.id && !g.revokedAt,
      )
    )
      throw new Error(
        "Named ChatGPT setup requires no preexisting grant in the disposable company",
      );
    const owners = [
        "Mira Patel",
        "Jonah Reed",
        "Lena Torres",
        "Owen Brooks",
        "Nadia Chen",
        "Theo Martin",
        "Iris Bennett",
        "Evan Hayes",
      ],
      ownerFact =
        owners[
          [...ctx.input.nonce].reduce((sum, c) => sum + c.charCodeAt(0), 0) %
            owners.length
        ]!;
    const task = await ctx.input.api.post<Issue>(`${root(ctx)}/issues`, {
      title: "Assistant setup control",
      description: `Synthetic setup qualification only. Launch owner: ${ownerFact}. No agent work is requested.`,
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: humanId,
      responsibleUserId: humanId,
    });
    if (
      task.assigneeAgentId ||
      task.assigneeUserId !== humanId ||
      task.status !== "backlog" ||
      task.watchdog
    )
      throw new Error(
        "Control task is not an inert human-owned backlog resource",
      );
    return {
      setupMetadataMatched: true,
      setupServerUrl: setup.serverUrl,
      humanId,
      operatorAvailable: availability.operatorAvailable,
      unauthenticatedMcpStatus,
      unauthenticatedHintDidNotGrant: isDeepStrictEqual(
        before.map((g) => g.id).sort(),
        after.map((g) => g.id).sort(),
      ),
      controlTaskId: task.id,
      controlIdentifier: task.identifier,
      controlBefore: taskIdentity(task),
      ownerFact,
      resultPath: `/${ctx.input.fixtures.company.issuePrefix}/apps/assistant-connection`,
      resultLabel: "Assistant Connection (MCP)",
    };
  },
  gradeChatgptSetup,
  {
    authentication: "human-session",
    ...runtimePrivateSpec("assistant-connections.connect-external-assistant"),
    expectedRunCount: 1,
    expectedHumanMessageCount: 1,
    turnTimeoutMs: 120000,
    attemptTimeoutMs: 1500000,
    sourceFiles: [
      "chat-catalog-domains/external-chatgpt-setup.ts",
      "chat-catalog-domains/external-chatgpt.ts",
      "chat-catalog-domains/external-chatgpt-worker.ts",
      "chat-catalog-domains/external-chatgpt-contract.ts",
      "chat-catalog-domains/runtime-private.ts",
      "chat-runtime-private-requirements.ts",
      "chat-catalog-domains/external-public-signin.ts",
      "chat-catalog-domains/external-public-signin-worker.ts",
      "chat-catalog-domains/external-public-signin-contract.ts",
      "public-mcp-flow.ts",
      "chat-public-origin.ts",
      "chat-catalog-domains/external-support.ts",
      "chat-catalog-domains/internal-support.ts",
      "chat-catalog-domains/identity-support.ts",
      "chat-scenarios/assistant-connections.yaml",
      "../../ui/src/pages/apps/AssistantConnection.tsx",
      "../../ui/src/pages/McpConnect.tsx",
      "../../server/src/routes/public-mcp.ts",
      "../../server/src/services/public-mcp/capabilities.ts",
      "../../server/src/services/public-mcp/oauth.ts",
      "../../packages/shared/src/mcp-setup.ts",
    ],
    async act(ctx, state) {
      await waitForReply(ctx);
      const o = await observeExternal(ctx, state);
      if (!truthfulChatgptHandoff(o.reply))
        throw new Error(
          "CEO invented connected ChatGPT state before actual human setup",
        );
      const source = ctx.input.page.url();
      const href = o.links.find((href) => {
        try {
          const u = new URL(href, o.origin);
          return u.origin === o.origin && u.pathname === state.resultPath;
        } catch {
          return false;
        }
      });
      if (!href)
        throw new Error("Actual intended company human setup link is missing");
      await ctx.input.page
        .locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`)
        .first()
        .click();
      await ctx.input.page
        .getByText("Set up manually", { exact: true })
        .click();
      await ctx.input.page
        .getByRole("tab", { name: "ChatGPT / Claude web", exact: true })
        .click();
      await expect(
        ctx.input.page
          .getByText(String(state.setupServerUrl), { exact: true })
          .first(),
      ).toBeVisible();
      state.actualBrowserInstructionsVisible = true;
      state.nativeBeforeQualification = await companyNativeIds(ctx);
      state.namedReceipt = await privateChatgptSetup(ctx, {
        id: String(state.controlTaskId),
        identifier: String(state.controlIdentifier),
        title: "Assistant setup control",
        ownerFact: String(state.ownerFact),
      });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    },
    async observe(ctx, state) {
      state.assistantConnections = await ctx.input.api.get<McpConnection[]>(
        "/api/mcp/connections",
      );
      const task = await ctx.input.api.get<Issue>(
          `/api/issues/${state.controlTaskId}`,
        ),
        comments = await ctx.input.api.get<IssueComment[]>(
          `/api/issues/${state.controlTaskId}/comments?order=asc`,
        );
      state.controlCommentCount = comments.length;
      state.controlComment = comments[0];
      state.controlTaskUnchanged = isDeepStrictEqual(
        taskIdentity(task),
        state.controlBefore,
      );
      state.noAgentAssignmentOrWatchdog =
        !task.assigneeAgentId &&
        task.assigneeUserId === state.humanId &&
        task.status === "backlog" &&
        !task.watchdog;
      state.zeroNativeAdmissions = isDeepStrictEqual(
        await companyNativeIds(ctx),
        state.nativeBeforeQualification,
      );
      state.currentPersonPreserved =
        (
          await ctx.input.api.get<{ user: { id: string } }>(
            "/api/auth/get-session",
          )
        ).user.id === state.humanId;
      return observeExternal(ctx, state);
    },
    async verifyResult(ctx, state) {
      const source = ctx.input.page.url();
      await ctx.input.page.goto(String(state.resultPath));
      await expect(
        ctx.input.page.getByRole("heading", {
          name: "Assistant Connection (MCP)",
          exact: true,
        }),
      ).toBeVisible();
      const receipt = state.namedReceipt as ChatgptReceipt;
      const rows = state.assistantConnections as McpConnection[];
      const grant = rows.find((g) => g.id === receipt.grantId);
      if (!grant)
        throw new Error(
          "Actual named ChatGPT public grant disappeared before result verification",
        );
      await expect(
        ctx.input.page.getByText(new RegExp(grant.clientName, "i")).first(),
      ).toBeVisible();
      await ctx.input.evidence("chat-catalog-named-chatgpt-setup.json", {
        grantId: receipt.grantId,
        requestId: receipt.requestId,
        commentId: receipt.commentId,
        companyId: ctx.input.fixtures.company.id,
        humanId: state.humanId,
        actualNamedUi: true,
        actualHumanConsent: true,
        zeroNativeAdmissions: state.zeroNativeAdmissions,
        consentWording: receipt.consentWording,
        acceptedScopes: receipt.acceptedScopes,
      });
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    },
    async cleanup(ctx, state) {
      try {
        await cleanupPrivateChatgpt(ctx);
      } finally {
        const receipt = state.namedReceipt as ChatgptReceipt | undefined;
        if (receipt?.grantId)
          await ctx.input.api.delete(
            `/api/mcp/connections/${receipt.grantId}`,
            { allowNotFound: true },
          );
        if (typeof state.controlTaskId === "string")
          await ctx.input.api.delete(`/api/issues/${state.controlTaskId}`, {
            allowNotFound: true,
          });
      }
    },
  },
);
