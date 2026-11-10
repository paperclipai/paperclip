import { expect } from "@playwright/test";
import { isDeepStrictEqual } from "node:util";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ConnectionIntentInteraction } from "../../../packages/shared/src/types/issue.js";
import type {
  ToolConnection,
  ToolConnectionHealthCheckResult,
  ToolCatalogRefreshResult,
  ToolConnectionTestCallResult,
  ToolRunDecisionLookup,
} from "../../../packages/shared/src/types/tool-access.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import {
  externalRequirements,
  selectedExternalBinding,
  selectedExternalCredential,
} from "./external-fixtures.js";
import {
  readNotionFixturePages,
  type NotionPageOracle,
} from "./external-notion-provider.js";
import {
  probeNotionAuthorization,
  qualifiedNotionExpiry,
} from "./external-notion-expiry.js";
import { privateNotionOAuth } from "./external-notion-oauth.js";
import {
  notionSelfWorkspaceMatches,
  type NotionOAuthReceipt,
} from "./external-notion-oauth-contract.js";
import {
  notionSetupSourceFiles,
  sharedNotionAuthority,
} from "./external-notion-setup.js";
import {
  notionDateMentioned,
  notionFactSpan,
  notionPageIdentityMatches,
} from "./external-notion-semantics.js";
import {
  definition,
  checks,
  externalObservation,
  observeExternal,
  root,
  verifyRenderedReply,
} from "./external-support.js";
async function decisions(ctx: ChatCatalogContext) {
  return Promise.all(
    (await ctx.allRuns()).map((run) =>
      ctx.input.api.get<ToolRunDecisionLookup>(
        `${root(ctx)}/tools/runs/${run.id}/decisions`,
      ),
    ),
  );
}
export function hasNotionAuthFailure(
  rows: ToolRunDecisionLookup[],
  runId: string,
  connectionId: string,
  issueId: string,
) {
  return rows.some(
    (row) =>
      row.runId === runId &&
      row.decisions.some(
        (d) =>
          d.invocation.runId === runId &&
          d.invocation.issueId === issueId &&
          d.invocation.connectionId === connectionId &&
          d.invocation.status === "failed" &&
          /401|unauthori[sz]ed|authentication|reauthorization|oauth.*(?:expired|required)|invalid.grant/i.test(
            `${d.invocation.errorCode ?? ""} ${d.invocation.errorMessage ?? ""}`,
          ),
      ),
  );
}
export function notionRepairGuidance(reply: string) {
  const falseCompletion = reply.split(/[.!?;\n]+|\bbut\b/i).some((clause) => {
    const claim =
      /\bI(?:['’]ve| have)?\s+(?:already\s+)?(?:reconnected|repaired|read|reviewed|summarized)\b|\b(?:Notion|(?:this|the) account)\s+(?:is|has been)\s+(?:now |already )?(?:reconnected|repaired|connected)\b/i.exec(
        clause,
      );
    if (!claim) return false;
    return !/\b(?:once|after|when|if|until|before)\b[^,]{0,80}$/i.test(
      clause.slice(0, claim.index),
    );
  });
  return (
    /notion/i.test(reply) &&
    /reconnect|reauthori[sz]|sign.?in.*again|authorization.*expir/i.test(
      reply,
    ) &&
    !falseCompletion
  );
}
async function pending(ctx: ChatCatalogContext, excluded: string[] = []) {
  const rows = await pollUntil({
    label: "new original-account Notion repair request",
    deadlineAt: Date.now() + 150000,
    load: async () => {
      await ctx.refreshIssue();
      return ctx.issue()
        ? ctx.input.api.get<ConnectionIntentInteraction[]>(
            `/api/issues/${ctx.issue()!.id}/interactions`,
          )
        : [];
    },
    accept: (rows) =>
      rows.some(
        (r) =>
          r.kind === "connection_intent" &&
          r.payload.serviceSlug === "notion" &&
          r.status === "pending" &&
          !excluded.includes(r.id),
      ),
  });
  const selected = rows.filter(
    (r) =>
      r.kind === "connection_intent" &&
      r.payload.serviceSlug === "notion" &&
      r.status === "pending" &&
      !excluded.includes(r.id),
  );
  if (selected.length !== 1)
    throw new Error("Repair requires exactly one new actual Notion request");
  if (typeof selected[0]!.sourceRunId !== "string")
    throw new Error(
      "Notion repair request lacks actual source native run attribution",
    );
  return { ...selected[0]!, sourceRunId: selected[0]!.sourceRunId };
}
async function waitForPhase(ctx: ChatCatalogContext, runId: string) {
  await pollUntil({
    label: "actual source-specific Notion request phase",
    deadlineAt: Date.now() + 150000,
    load: async () => {
      await ctx.refreshIssue();
      return ctx.allRuns();
    },
    accept: (rows) =>
      rows.some((r) => r.id === runId && r.status === "succeeded") &&
      ctx.issue()?.conversationState === "waiting",
    reject: (rows) =>
      rows.some(
        (r) =>
          r.id === runId &&
          ["failed", "cancelled", "timed_out"].includes(r.status),
      )
        ? "Actual Notion source phase failed"
        : undefined,
  });
}
export function gradeNotionExpired(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "actual-expired-notion-phases",
    !!o,
    "Actual expired provider authorization, cancellation and later successful same-account repair are required.",
  );
  if (!o) return c.result();
  const first = o.interactions.find(
    (r) => r.id === o.state.firstIntentId,
  ) as unknown as ConnectionIntentInteraction | undefined;
  const final = o.interactions.find(
    (r) => r.id === o.state.finalIntentId,
  ) as unknown as ConnectionIntentInteraction | undefined;
  const receipt = o.state.repairReceipt as NotionOAuthReceipt | undefined;
  c.add(
    "genuine-natural-expiry-context",
    o.state.validBeforeExpiry === true &&
      o.state.sameWorkspaceBeforeExpiry === true &&
      o.state.actualProvider401 === true &&
      o.state.expiryQualified === true,
    "A real currently valid official OAuth credential first works, then actually returns provider HTTP401 after qualified natural expiry; no injected failure or token mutation.",
  );
  c.add(
    "original-native-authentication-error",
    o.state.firstAuthFailure === true &&
      notionRepairGuidance(String(o.state.firstReply ?? "")) &&
      o.state.exactReconnectPath === true,
    "The original canonical native read fails against the existing connection and truthful chat identifies its actual supported reconnect route before any human action.",
  );
  c.add(
    "actual-cancel-preserves-incomplete-research",
    !!first &&
      first.result?.outcome === "declined" &&
      first.addresseeUserId === o.state.humanId &&
      first.resolvedByUserId === o.state.humanId &&
      !first.resolvedByAgentId &&
      o.state.cancelledSnapshot === true &&
      o.state.cancelConnectionUnchanged === true &&
      o.state.cancelNoSuccessfulRead === true &&
      o.state.truthfulCancelReply === true,
    "The addressed person's actual Not now decision is retained; its own continuation reports no research, without repaired credentials, successful reads or a repeated request before a new human request.",
  );
  c.add(
    "explicit-repeat-request-lineage",
    !!final &&
      final.id !== first?.id &&
      o.humanQueries.length === 2 &&
      o.humanQueries.every((q) => q === o.humanQueries[0]) &&
      o.state.finalAuthFailure === true &&
      o.state.finalGuidanceCorrect === true &&
      final.addresseeUserId === o.state.humanId &&
      final.sourceRunId === o.state.finalInitialRunId,
    "A second unchanged human request creates its own distinct actual failed-read/repair phase; cancellation never acts as consent.",
  );
  c.add(
    "actual-same-account-human-reconnect",
    !!receipt &&
      receipt.connectionId === o.state.connectionId &&
      receipt.intentId === final?.id &&
      receipt.humanId === o.state.humanId &&
      receipt.personalDraft === false &&
      receipt.credentialAbsentAtHandoff === false &&
      receipt.providerHandoff === true &&
      receipt.providerHumanMatched === true &&
      receipt.callbackReturned === true &&
      receipt.workspaceMatched === true &&
      receipt.consentCompleted === true &&
      receipt.processIsolation === true &&
      receipt.testRunnerAttached === false &&
      receipt.tracingEnabled === false &&
      receipt.videoEnabled === false &&
      final?.result?.outcome === "connected" &&
      final.result.connectionId === o.state.connectionId &&
      final.resolvedByUserId === o.state.humanId &&
      o.state.authorityPreserved === true &&
      o.connections.length === 1,
    "Actual normal Notion OAuth reconnect repairs the same existing connection and original scope/person/request, with no duplicate account or API credential rescue.",
  );
  const rows = o.state.decisions as ToolRunDecisionLookup[] | undefined;
  c.add(
    "fresh-post-repair-native-read",
    !!rows?.some(
      (row) =>
        row.runId !== o.state.firstInitialRunId &&
        row.runId !== o.state.finalInitialRunId &&
        (o.state.repairRunIds as string[] | undefined)?.includes(row.runId) &&
        row.decisions.some(
          (d) =>
            d.invocation.runId === row.runId &&
            d.invocation.agentId === o.leadId &&
            d.invocation.issueId === o.state.sourceIssueId &&
            d.invocation.connectionId === o.state.connectionId &&
            d.invocation.status === "succeeded" &&
            (o.state.readEntryIds as string[] | undefined)?.includes(
              d.invocation.catalogEntryId ?? "",
            ),
        ),
    ),
    "A new success continuation actually reads the real provider after human repair; independent setup probes cannot substitute.",
  );
  const recent = (o.state.pages as NotionPageOracle[] | undefined)?.[0],
    reply = String(o.state.repairedReply ?? "");
  c.add(
    "no-pre-repair-cached-summary",
    !!recent &&
      [
        o.state.firstReply,
        o.state.finalInitialReply,
        o.state.cancelReply,
      ].every(
        (reply) =>
          typeof reply === "string" && !notionFactSpan(reply, recent.fact),
      ),
    "Initial failure, cancellation and explicit re-request cannot report cached launch facts as fresh provider research before repair.",
  );
  c.add(
    "fresh-grounded-summary-after-repair",
    !!recent &&
      !!notionFactSpan(reply, recent.fact) &&
      notionDateMentioned(reply, recent.editedAt) &&
      o.links.some((link) => notionPageIdentityMatches(link, recent.id)) &&
      o.state.pagesUnchanged === true,
    "Only the post-repair native reply summarizes current source body/date/link, never cached material as fresh research.",
  );
  return c.result();
}
export const notionExpiredExternalCases = [
  definition(
    "connection-setup.notion-expired",
    async (ctx) => {
      const binding = selectedExternalBinding(ctx),
        p = binding.prerequisites;
      if (!qualifiedNotionExpiry(p, Date.now()))
        throw new Error(
          "Setup blocker: designated natural-expiry Notion OAuth access token must expire in two to eight minutes",
        );
      if (
        (
          await ctx.input.api.get<{ connections: ToolConnection[] }>(
            `${root(ctx)}/tools/connections`,
          )
        ).connections.length
      )
        throw new Error(
          "Expired Notion fixture requires a fresh disposable company",
        );
      const pages = await readNotionFixturePages(ctx),
        old = await probeNotionAuthorization(ctx, binding);
      if (!old.validWorkspace || old.authenticationDenied)
        throw new Error(
          "Setup blocker: actual old Notion OAuth authorization is not initially valid for the selected workspace",
        );
      const credential = selectedExternalCredential(
        ctx,
        binding,
        "expiredAuthorizationEnv",
      );
      const secret = await ctx.input.api.postSensitive<{ id: string }>(
        `${root(ctx)}/secrets`,
        {
          name: "Historical Notion OAuth authorization",
          key: "chat-eval-notion-old-authorization",
          provider: "local_encrypted",
          value: credential,
        },
      );
      let connection: ToolConnection | undefined;
      try {
        connection = await ctx.input.api.post<ToolConnection>(
          `${root(ctx)}/tools/connections`,
          {
            name: "Launch Notion",
            applicationName: "Notion",
            transport: "mcp_remote",
            authKind: "oauth",
            credentialPolicy: "shared",
            ownership: "customer",
            config: {
              url: p.mcpUrl,
              sourceTemplateKey: "notion",
              connectionMethodKey: "mcp-oauth",
            },
            transportConfig: {
              url: p.mcpUrl,
              sourceTemplateKey: "notion",
              connectionMethodKey: "mcp-oauth",
            },
            credentialSecretRefs: [
              {
                configPath: "oauth.access_token",
                secretId: secret.id,
                versionSelector: "latest",
                required: true,
              },
            ],
            credentialRefs: [
              {
                name: "oauth.access_token",
                secretId: secret.id,
                version: "latest",
                placement: "header",
                key: "Authorization",
                prefix: "Bearer ",
              },
            ],
          },
        );
        const health =
          await ctx.input.api.post<ToolConnectionHealthCheckResult>(
            `/api/tool-connections/${connection.id}/health-check`,
            {},
          );
        if (health.connection.healthStatus !== "ok")
          throw new Error(
            "Setup blocker: historical named Notion credential failed actual health qualification",
          );
        const refresh = await ctx.input.api.post<ToolCatalogRefreshResult>(
            `/api/tool-connections/${connection.id}/catalog/refresh`,
            {},
          ),
          read = refresh.catalog
            .filter((e) => e.isReadOnly && e.status === "active")
            .map((e) => e.id);
        if (!read.length)
          throw new Error(
            "Setup blocker: actual Notion read catalog is unavailable before natural expiry",
          );
        await ctx.input.api.post(
          `${root(ctx)}/tools/apps/${connection.id}/finish`,
          {
            enabledCatalogEntryIds: read,
            askFirstCatalogEntryIds: [],
            access: { agentIds: [ctx.input.fixtures.agent.id] },
          },
        );
        const proof =
          await ctx.input.api.postSensitive<ToolConnectionTestCallResult>(
            `/api/tool-connections/${connection.id}/test-calls`,
            {
              agentId: ctx.input.fixtures.agent.id,
              toolName: "notion-get-self",
              parameters: {},
            },
          );
        if (
          proof.decision !== "allowed" ||
          proof.error ||
          !notionSelfWorkspaceMatches(proof.result, p.workspaceId!)
        )
          throw new Error(
            "Setup blocker: actual stored existing Notion OAuth authorization did not prove intended workspace before expiry",
          );
        const authorityBefore = await sharedNotionAuthority(ctx, connection.id),
          expires = Date.parse(p.authorizationExpiresAt!);
        while (Date.now() < expires)
          await new Promise((r) =>
            setTimeout(r, Math.min(10000, expires - Date.now())),
          );
        let actualProvider401 = false;
        for (let n = 0; n < 3; n++) {
          const probe = await probeNotionAuthorization(ctx, binding);
          if (probe.authenticationDenied) {
            actualProvider401 = true;
            break;
          }
          if (n < 2) await new Promise((r) => setTimeout(r, 5000));
        }
        if (!actualProvider401)
          throw new Error(
            "Setup blocker: designated Notion authorization did not actually fail with provider HTTP401 at its qualified natural expiry",
          );
        return {
          connectionId: connection.id,
          secretId: secret.id,
          pages,
          readEntryIds: read,
          authorityBefore,
          validBeforeExpiry: true,
          sameWorkspaceBeforeExpiry: true,
          expiryQualified: true,
          actualProvider401,
          humanId: (
            await ctx.input.api.get<{ user: { id: string } }>(
              "/api/auth/get-session",
            )
          ).user.id,
        };
      } catch (error) {
        if (connection)
          await ctx.input.api.delete(`/api/tool-connections/${connection.id}`, {
            allowNotFound: true,
          });
        await ctx.input.api.delete(`${root(ctx)}/secrets/${secret.id}`, {
          allowNotFound: true,
        });
        throw error;
      }
    },
    gradeNotionExpired,
    {
      authentication: "human-session",
      externalInput: externalRequirements["connection-setup.notion-expired"],
      expectedRunCount: 4,
      minimumRunCount: 4,
      expectedHumanMessageCount: 2,
      turnTimeoutMs: 120000,
      attemptTimeoutMs: 1500000,
      sourceFiles: [
        ...notionSetupSourceFiles,
        "chat-catalog-domains/external-notion-expired.ts",
        "chat-catalog-domains/external-notion-expiry.ts",
        "chat-catalog-domains/identity-support.ts",
        "chat-flow.ts",
        "../../server/src/services/tool-access.ts",
      ],
      async act(ctx, state) {
        const first = await pending(ctx);
        state.firstIntentId = first.id;
        state.firstInitialRunId = first.sourceRunId;
        state.sourceIssueId = ctx.issue()!.id;
        await waitForPhase(ctx, first.sourceRunId);
        const before = await observeExternal(ctx, state);
        state.firstReply = before.phaseReplies
          .filter((r) => r.runId === first.sourceRunId)
          .map((r) => r.body)
          .join("\n");
        state.firstAuthFailure = hasNotionAuthFailure(
          await decisions(ctx),
          first.sourceRunId,
          String(state.connectionId),
          ctx.issue()!.id,
        );
        const path = `/${ctx.input.fixtures.company.issuePrefix}/apps/connect`,
          correct = (href: string) => {
            try {
              const u = new URL(href, ctx.input.api.baseURL);
              return (
                u.origin === ctx.input.api.baseURL &&
                u.pathname === path &&
                u.searchParams.get("source") === "notion" &&
                u.searchParams.get("reconnect") === state.connectionId
              );
            } catch {
              return false;
            }
          };
        state.exactReconnectPath = before.links.some(correct);
        if (
          first.addresseeUserId !== state.humanId ||
          !state.firstAuthFailure ||
          !state.exactReconnectPath ||
          !notionRepairGuidance(String(state.firstReply))
        )
          throw new Error(
            "Actual initial Notion error/guidance does not identify the real existing account's reconnect flow",
          );
        await expect(
          ctx.input.page.getByRole("button", { name: "Not now", exact: true }),
        ).toBeVisible();
        await ctx.input.page
          .getByRole("button", { name: "Not now", exact: true })
          .click();
        const cancellation = await pollUntil({
          label: "truthful actual cancellation continuation",
          deadlineAt: Date.now() + 150000,
          load: () => observeExternal(ctx, state),
          accept: (o) =>
            o.phaseReplies.some(
              (r) =>
                r.runId !== first.sourceRunId &&
                o.runs.some(
                  (run) => run.id === r.runId && run.status === "succeeded",
                ),
            ),
        });
        const cancelRows = await decisions(ctx),
          cancelReply = cancellation.phaseReplies
            .filter((r) => r.runId !== first.sourceRunId)
            .map((r) => r.body)
            .join("\n"),
          recent = (state.pages as NotionPageOracle[])[0]!;
        state.cancelledSnapshot =
          cancellation.interactions.filter(
            (r) => r.kind === "connection_intent",
          ).length === 1 &&
          cancellation.interactions.some(
            (r) =>
              r.id === first.id &&
              (r as unknown as ConnectionIntentInteraction).result?.outcome ===
                "declined",
          );
        state.cancelConnectionUnchanged = isDeepStrictEqual(
          await sharedNotionAuthority(ctx, String(state.connectionId)),
          state.authorityBefore,
        );
        state.cancelNoSuccessfulRead = !cancelRows.some((r) =>
          r.decisions.some(
            (d) =>
              d.invocation.connectionId === state.connectionId &&
              d.invocation.status === "succeeded",
          ),
        );
        state.cancelReply = cancelReply;
        state.truthfulCancelReply =
          /not|couldn.t|cannot|can.t|declin|cancel|incomplete|unable/i.test(
            cancelReply,
          ) &&
          /read|summary|research|notion/i.test(cancelReply) &&
          !notionFactSpan(cancelReply, recent.fact) &&
          !/\bI(?:['’]ve| have)?\s+(?:already\s+)?(?:read|reviewed|summarized|reconnected)\b/i.test(
            cancelReply,
          );
        await ctx.input.evidence("chat-catalog-notion-cancel-phase.json", {
          intentId: first.id,
          sourceIssueId: state.sourceIssueId,
          firstRunId: first.sourceRunId,
          cancelRunIds: cancellation.runs
            .filter((r) => r.id !== first.sourceRunId)
            .map((r) => r.id),
          cancelled: state.cancelledSnapshot,
          noSuccessfulRead: state.cancelNoSuccessfulRead,
          authorityUnchanged: state.cancelConnectionUnchanged,
          truthfulReply: state.truthfulCancelReply,
        });
        if (
          !state.cancelledSnapshot ||
          !state.cancelNoSuccessfulRead ||
          !state.cancelConnectionUnchanged ||
          !state.truthfulCancelReply
        )
          throw new Error(
            "Actual cancellation phase did not retain truthful incomplete research before re-request",
          );
        const beforeRepairRunIds = (await ctx.allRuns()).map((r) => r.id);
        await sendChatMessage(ctx.input.page, ctx.scenario.query);
        const final = await pending(ctx, [first.id]);
        state.finalIntentId = final.id;
        state.finalInitialRunId = final.sourceRunId;
        await waitForPhase(ctx, final.sourceRunId);
        const again = await observeExternal(ctx, state);
        const reply = again.phaseReplies
          .filter((r) => r.runId === final.sourceRunId)
          .map((r) => r.body)
          .join("\n");
        state.finalInitialReply = reply;
        state.finalAuthFailure = hasNotionAuthFailure(
          await decisions(ctx),
          final.sourceRunId,
          String(state.connectionId),
          String(state.sourceIssueId),
        );
        state.finalGuidanceCorrect =
          notionRepairGuidance(reply) && again.links.some(correct);
        if (
          final.addresseeUserId !== state.humanId ||
          !state.finalAuthFailure ||
          !state.finalGuidanceCorrect
        )
          throw new Error(
            "Actual repeated request does not truthfully direct repair of the same failed Notion account",
          );
        state.repairReceipt = await privateNotionOAuth(ctx, {
          operation: "authorize",
          intentId: final.id,
          reconnectId: String(state.connectionId),
        });
        state.beforeRepairRunIds = [...beforeRepairRunIds, final.sourceRunId];
        await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      },
      async observe(ctx, state) {
        const o = await observeExternal(ctx, state);
        state.decisions = await decisions(ctx);
        state.authorityPreserved = isDeepStrictEqual(
          await sharedNotionAuthority(ctx, String(state.connectionId)),
          state.authorityBefore,
        );
        state.repairRunIds = o.runs
          .filter(
            (r) =>
              !((state.beforeRepairRunIds as string[]) ?? []).includes(r.id),
          )
          .map((r) => r.id);
        state.repairedReply = o.phaseReplies
          .filter((r) => (state.repairRunIds as string[]).includes(r.runId))
          .map((r) => r.body)
          .join("\n");
        const pages = await readNotionFixturePages(ctx),
          before = state.pages as NotionPageOracle[];
        state.pagesUnchanged =
          pages.length === before.length &&
          pages.every(
            (p, n) =>
              p.id === before[n]?.id &&
              p.editedAt === before[n]?.editedAt &&
              p.marker === before[n]?.marker,
          );
        return { ...o, state };
      },
      async verifyResult(ctx, state, value) {
        await verifyRenderedReply(ctx, value, String(state.finalInitialRunId));
        const o = externalObservation(value)!,
          recent = (state.pages as NotionPageOracle[])[0]!,
          href = o.links.find((link) =>
            notionPageIdentityMatches(link, recent.id),
          );
        if (!href)
          throw new Error(
            "Current Notion source is missing after real reconnect",
          );
        await expect(
          ctx.input.page
            .locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`)
            .first(),
        ).toBeVisible();
        await ctx.input.evidence("chat-catalog-notion-repair.json", {
          connectionId: state.connectionId,
          firstIntentId: state.firstIntentId,
          finalIntentId: state.finalIntentId,
          initialRunId: state.firstInitialRunId,
          repeatedRunId: state.finalInitialRunId,
          repairRunIds: state.repairRunIds,
          receipt: state.repairReceipt,
          authorityPreserved: state.authorityPreserved,
        });
      },
      async cleanup(ctx, state) {
        if (typeof state.connectionId === "string")
          await ctx.input.api.delete(
            `/api/tool-connections/${state.connectionId}`,
            { allowNotFound: true },
          );
        if (typeof state.secretId === "string")
          await ctx.input.api.delete(`${root(ctx)}/secrets/${state.secretId}`, {
            allowNotFound: true,
          });
      },
    },
  ),
];
