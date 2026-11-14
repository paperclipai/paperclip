import { expect } from "@playwright/test";
import type { ConnectionIntentInteraction } from "../../../packages/shared/src/types/issue.js";
import type {
  ToolConnection,
  ConnectionGrantsResponse,
  ToolRunDecisionLookup,
  ToolProfileEffectiveSummary,
  ToolConnectionTestCallResult,
} from "../../../packages/shared/src/types/tool-access.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import {
  externalRequirements,
  selectedExternalBinding,
} from "./external-fixtures.js";
import { privateNotionOAuth } from "./external-notion-oauth.js";
import {
  notionSelfWorkspaceMatches,
  type NotionOAuthReceipt,
} from "./external-notion-oauth-contract.js";
import {
  readNotionFixturePages,
  connectNamedNotion,
  verifyNotionWorkspace,
  verifyNotionPersonalPageDenied,
  type NotionPageOracle,
} from "./external-notion-provider.js";
import {
  notionDateMentioned,
  notionFactSpan,
  notionPageIdentityMatches,
} from "./external-notion-semantics.js";
import {
  checks,
  definition,
  externalObservation,
  observeExternal,
  root,
  verifyRenderedReply,
} from "./external-support.js";

export function personalNotionGuidance(text: string) {
  return text
    .split(/[.!?;\n]+/)
    .some(
      (clause) =>
        /\bpersonal\b/i.test(clause) &&
        /\b(?:connect|authorize|authorization|sign.?in)\b/i.test(clause) &&
        !/\bI(?:['’]ve| have)?\s+(?:already\s+)?(?:connected|authorized)\b/i.test(
          clause,
        ),
    );
}
export async function sharedNotionAuthority(
  ctx: ChatCatalogContext,
  id: string,
) {
  const connection = await ctx.input.api.get<ToolConnection>(
    `/api/tool-connections/${id}`,
  );
  const { grants } = await ctx.input.api.get<ConnectionGrantsResponse>(
    `/api/tool-connections/${id}/grants`,
  );
  const { installs } = await ctx.input.api.get<{
    installs: Array<{ targetType: string; targetId: string }>;
  }>(`/api/tool-connections/${id}/installs`);
  const sorted = (rows: unknown[]) =>
    rows.map((row) => JSON.stringify(row)).sort();
  return {
    id: connection.id,
    companyId: connection.companyId,
    enabled: connection.enabled,
    credentialPolicy: connection.credentialPolicy,
    ownership: connection.ownership,
    grants: sorted(
      grants.map((g) => ({
        id: g.id,
        kind: g.kind,
        subjectUserId: g.subjectUserId,
        subjectAgentId: g.subjectAgentId,
        status: g.status,
        members: sorted(
          (g.members ?? []).map((m) => ({
            subjectType: m.subjectType,
            subjectId: m.subjectId,
          })),
        ),
        delegations: sorted(
          (g.delegations ?? []).map((d) => ({ agentId: d.agentId })),
        ),
      })),
    ),
    installs: sorted(
      installs.map((i) => ({ targetType: i.targetType, targetId: i.targetId })),
    ),
  };
}
export function gradeNotionSetup(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "actual-personal-notion-setup-evidence",
    !!o,
    "Actual named-provider setup, pending request and provider-native read evidence are required.",
  );
  if (!o) return c.result();
  const card = o.interactions.find(
    (row) => row.id === o.state.intentId,
  ) as unknown as ConnectionIntentInteraction | undefined;
  const receipt = o.state.oauthReceipt as NotionOAuthReceipt | undefined;
  const initial = o.phaseReplies
    .filter((row) => row.runId === o.state.initialRunId)
    .map((row) => row.body)
    .join("\n");
  const continuation = o.phaseReplies
    .filter((row) => row.runId !== o.state.initialRunId)
    .map((row) => row.body)
    .join("\n");
  const pages = o.state.pages as NotionPageOracle[] | undefined,
    recent = pages?.[0],
    older = pages?.[1];
  c.add(
    "single-addressed-pending-request",
    !!card &&
      o.interactions.filter((row) => row.kind === "connection_intent")
        .length === 1 &&
      card.sourceRunId === o.state.initialRunId &&
      card.addresseeUserId === o.state.humanId &&
      o.state.pendingBeforeHuman === true &&
      o.state.cardVisible === true &&
      o.state.pendingWithoutCredential === true,
    "The original model's addressed request remains pending without credentials; no hidden replacement or premature resolution.",
  );
  c.add(
    "no-premature-unseen-summary",
    !!recent &&
      !notionFactSpan(initial, recent.fact) &&
      (!older || !notionFactSpan(initial, older.fact)) &&
      !/\b(?:I(?: have|'ve|’ve)? (?:already )?(?:read|reviewed|summarized)|here(?: is|'s|’s) (?:the |your )?(?:latest|launch summary))/i.test(
        initial,
      ),
    "The setup reply cannot claim research or substitute unseen page facts before human authorization.",
  );
  c.add(
    "actual-human-provider-consent",
    !!receipt &&
      receipt.humanId === o.state.humanId &&
      receipt.intentId === card?.id &&
      receipt.personalDraft === true &&
      receipt.credentialAbsentAtHandoff === true &&
      receipt.providerHandoff === true &&
      receipt.consentCompleted === true &&
      receipt.callbackReturned === true &&
      receipt.workspaceMatched === true &&
      receipt.providerHumanMatched === true &&
      receipt.processIsolation === true &&
      receipt.testRunnerAttached === false &&
      receipt.tracingEnabled === false &&
      receipt.videoEnabled === false,
    "The addressed fixture person actually completes full-page named Notion consent and returns; private get-self independently proves the selected workspace.",
  );
  c.add(
    "same-usable-personal-connection",
    !!card &&
      card.result?.outcome === "connected" &&
      card.result.connectionId === receipt?.connectionId &&
      card.resolvedByUserId === o.state.humanId &&
      !card.resolvedByAgentId &&
      o.state.connectionId === receipt?.connectionId &&
      o.connections.length ===
        (o.scenarioId === "connection-setup.notion-wrong-account" ? 2 : 1) &&
      o.state.samePersonalActive === true &&
      o.state.currentHumanPreserved === true &&
      o.state.originalSourcePreserved === true,
    "Only the original personal draft becomes usable; the actual callback resolves the same request/user/conversation with one account.",
  );
  const decisions = o.state.decisions as ToolRunDecisionLookup[] | undefined;
  c.add(
    "new-canonical-continuation-read",
    !!decisions?.some(
      (row) =>
        row.runId !== o.state.initialRunId &&
        o.runs.some(
          (run) => run.id === row.runId && run.status === "succeeded",
        ) &&
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
    "A new native continuation actually reads through the newly authorized Notion connection; the independent get-self/oracle read is insufficient.",
  );
  c.add(
    "current-body-date-and-source",
    !!recent &&
      !!notionFactSpan(continuation, recent.fact) &&
      notionDateMentioned(continuation, recent.editedAt) &&
      o.links.some((link) => notionPageIdentityMatches(link, recent.id)) &&
      (!older ||
        !notionFactSpan(continuation, older.fact) ||
        /older|background|previous|earlier/i.test(continuation)) &&
      o.state.pagesUnchanged === true,
    "The continuation summarizes the actual recent body fact with its real date/source, distinguishing older background.",
  );
  if (o.scenarioId === "connection-setup.notion-wrong-account") {
    c.add(
      "actual-shared-personal-mismatch",
      o.state.sharedWorkspaceMatched === true &&
        o.state.sharedMcpWorkspaceMatched === true &&
        o.state.sharedCannotReadPersonal === true &&
        o.state.sharedConnectionId !== o.state.connectionId &&
        personalNotionGuidance(initial),
      "The existing healthy shared workspace really lacks the known personal page; actual guidance requests the personal workspace rather than substituting shared notes.",
    );
    c.add(
      "shared-authority-preserved",
      o.state.sharedAuthorityPreserved === true,
      "Actual shared account ownership, human audience, agent delegation and installs remain unchanged after creating the explicitly personal account.",
    );
  }
  if (o.scenarioId === "connection-setup.save-and-resume") {
    const saved = o.state.savedDraft as NotionOAuthReceipt | undefined;
    c.add(
      "real-human-saved-uncredentialed-draft",
      !!saved &&
        saved.personalDraft === true &&
        saved.credentialAbsentAtHandoff === true &&
        saved.providerHandoff === true &&
        saved.draftSurvivedReload === true &&
        !saved.consentCompleted &&
        !saved.callbackReturned &&
        saved.intentId === null &&
        saved.connectionId === receipt?.connectionId &&
        receipt?.resumedSameDraft === true &&
        o.state.savedBeforeCanonical === true,
      "Before the canonical query, actual Continue to Notion saves personal choices; the human leaves before credentials, reloads, and later authorizes that same durable draft.",
    );
  }
  return c.result();
}
export const notionSetupSourceFiles = [
  "chat-catalog-domains/external-notion-setup.ts",
  "chat-catalog-domains/external-notion-oauth.ts",
  "chat-catalog-domains/external-notion-oauth-worker.ts",
  "chat-catalog-domains/external-notion-oauth-contract.ts",
  "chat-catalog-domains/external-notion-provider.ts",
  "chat-catalog-domains/external-notion-semantics.ts",
  "chat-catalog-domains/external-public-signin.ts",
  "chat-catalog-domains/external-public-signin-worker.ts",
  "chat-catalog-domains/external-public-signin-contract.ts",
  "public-mcp-flow.ts",
  "chat-public-origin.ts",
  "chat-catalog-domains/external-fixtures.ts",
  "chat-catalog-domains/external-support.ts",
  "chat-catalog-domains/internal-support.ts",
  "chat-scenarios/connection-setup.yaml",
  "../../ui/src/features/connections/ConnectionSetupFlow.tsx",
  "../../ui/src/features/connections/ConnectionIntentInteractionBody.tsx",
  "../../server/src/routes/tool-access.ts",
  "../../server/src/services/tool-access/oauth/direct-callback.ts",
  "../../scripts/smoke/notion-generic-live.mjs",
];
export const notionSetupExternalCases = [
  "connection-setup.notion-missing",
  "connection-setup.return-from-login",
  "connection-setup.save-and-resume",
  "connection-setup.notion-wrong-account",
].map((id) =>
  definition(
    id,
    async (ctx) => {
      const connections = (
        await ctx.input.api.get<{ connections: ToolConnection[] }>(
          `${root(ctx)}/tools/connections`,
        )
      ).connections;
      if (connections.length)
        throw new Error(
          "No-connection Notion setup requires a fresh disposable company",
        );
      const pages = await readNotionFixturePages(ctx);
      const humanId = (
        await ctx.input.api.get<{ user: { id: string } }>(
          "/api/auth/get-session",
        )
      ).user.id;
      const state: Record<string, unknown> = {
        pages,
        humanId,
        baselineConnectionIds: [],
        savedBeforeCanonical: false,
      };
      if (id === "connection-setup.notion-wrong-account") {
        const binding = selectedExternalBinding(ctx),
          p = binding.prerequisites;
        if (
          p.sharedWorkspaceId!.replaceAll("-", "").toLowerCase() ===
          p.workspaceId!.replaceAll("-", "").toLowerCase()
        )
          throw new Error(
            "Setup blocker: shared and personal Notion workspaces must be genuinely distinct",
          );
        const shared = {
          ...binding,
          prerequisites: {
            ...p,
            workspaceId: p.sharedWorkspaceId!,
            apiTokenEnv: p.sharedApiTokenEnv!,
            mcpTokenEnv: p.sharedMcpTokenEnv!,
          },
        };
        await verifyNotionWorkspace(ctx, shared);
        await verifyNotionPersonalPageDenied(ctx, shared, p.recentPageId!);
        const connected = await connectNamedNotion(ctx, shared, [
          ctx.input.fixtures.agent.id,
        ]);
        const proof =
          await ctx.input.api.postSensitive<ToolConnectionTestCallResult>(
            `/api/tool-connections/${connected.connectionId}/test-calls`,
            {
              agentId: ctx.input.fixtures.agent.id,
              toolName: "notion-get-self",
              parameters: {},
            },
          );
        if (
          proof.decision !== "allowed" ||
          proof.error ||
          !notionSelfWorkspaceMatches(proof.result, p.sharedWorkspaceId!)
        ) {
          await ctx.input.api.delete(
            `/api/tool-connections/${connected.connectionId}`,
            { allowNotFound: true },
          );
          throw new Error(
            "Setup blocker: actual existing shared MCP authorization does not match its designated workspace",
          );
        }
        state.sharedMcpWorkspaceMatched = true;
        state.sharedConnectionId = connected.connectionId;
        state.sharedAuthorityBefore = await sharedNotionAuthority(
          ctx,
          connected.connectionId,
        );
        state.sharedWorkspaceMatched = true;
        state.sharedCannotReadPersonal = true;
      }
      if (id === "connection-setup.save-and-resume") {
        try {
          state.savedDraft = await privateNotionOAuth(ctx, {
            operation: "save-draft",
          });
          state.savedBeforeCanonical = true;
        } catch (error) {
          // Every connection in this newly owned disposable company was created by
          // this one finite UI operation. Do not leave an unreturned private draft.
          for (const row of (
            await ctx.input.api.get<{ connections: ToolConnection[] }>(
              `${root(ctx)}/tools/connections`,
            )
          ).connections)
            await ctx.input.api.delete(`/api/tool-connections/${row.id}`, {
              allowNotFound: true,
            });
          throw error;
        }
      }
      return state;
    },
    gradeNotionSetup,
    {
      authentication: "human-session",
      externalInput: externalRequirements[id],
      expectedRunCount: 2,
      minimumRunCount: 2,
      expectedHumanMessageCount: 1,
      turnTimeoutMs: 120000,
      attemptTimeoutMs: 900000,
      sourceFiles: notionSetupSourceFiles,
      async act(ctx, state) {
        const rows = await pollUntil({
          label: "actual addressed pending Notion request",
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
              (row) =>
                row.kind === "connection_intent" &&
                row.status === "pending" &&
                row.payload.serviceSlug === "notion",
            ),
        });
        const pending = rows.filter(
          (row) =>
            row.kind === "connection_intent" &&
            row.status === "pending" &&
            row.payload.serviceSlug === "notion",
        );
        if (
          pending.length !== 1 ||
          pending[0]!.addresseeUserId !== state.humanId ||
          pending[0]!.payload.requestingAgentId !== ctx.input.fixtures.agent.id
        )
          throw new Error(
            "Notion request is not uniquely addressed to the actual fixture person/requesting CEO",
          );
        const card = pending[0]!;
        state.intentId = card.id;
        state.initialRunId = card.sourceRunId;
        state.sourceIssueId = ctx.issue()!.id;
        state.pendingBeforeHuman = true;
        await expect(
          ctx.input.page
            .getByRole("button", {
              name: /^(Connect|Connect \/ Use existing)$/,
              exact: true,
            })
            .first(),
        ).toBeVisible();
        state.cardVisible = true;
        const before = (
          await ctx.input.api.get<{ connections: ToolConnection[] }>(
            `${root(ctx)}/tools/connections`,
          )
        ).connections;
        const saved = state.savedDraft as NotionOAuthReceipt | undefined;
        state.pendingWithoutCredential =
          before.filter((row) => row.id !== state.sharedConnectionId).length ===
            (saved ? 1 : 0) &&
          before
            .filter((row) => row.id !== state.sharedConnectionId)
            .every(
              (row) =>
                row.id === saved?.connectionId &&
                row.status === "draft" &&
                row.credentialPolicy === "per_user" &&
                !row.credentialSecretRefs.length &&
                !row.credentialRefs?.length,
            );
        const current = await observeExternal(ctx, state);
        const initial = current.phaseReplies
          .filter((row) => row.runId === card.sourceRunId)
          .map((row) => row.body)
          .join("\n");
        const pages = state.pages as NotionPageOracle[];
        if (
          !state.pendingWithoutCredential ||
          !initial.trim() ||
          pages.some((page) => notionFactSpan(initial, page.fact))
        )
          throw new Error(
            "Notion request was prematurely satisfied or already exposed unseen fixture facts",
          );
        if (
          id === "connection-setup.notion-wrong-account" &&
          !personalNotionGuidance(initial)
        )
          throw new Error(
            "Actual Notion guidance does not identify the requested personal workspace before the human acts",
          );
        // The visible addressed card's supported full-page setup host preserves the
        // exact same intent. No API connection or completion substitutes for UI.
        state.oauthReceipt = await privateNotionOAuth(ctx, {
          operation: "authorize",
          intentId: card.id,
          ...(saved ? { draftId: saved.connectionId } : {}),
        });
        state.connectionId = (
          state.oauthReceipt as NotionOAuthReceipt
        ).connectionId;
        await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
      },
      async observe(ctx, state) {
        const o = await observeExternal(ctx, state),
          receipt = state.oauthReceipt as NotionOAuthReceipt | undefined;
        if (receipt) {
          const connection = await ctx.input.api.get<ToolConnection>(
            `/api/tool-connections/${receipt.connectionId}`,
          );
          const grants = await ctx.input.api.get<ConnectionGrantsResponse>(
            `/api/tool-connections/${receipt.connectionId}/grants`,
          );
          state.samePersonalActive =
            connection.companyId === ctx.input.fixtures.company.id &&
            connection.status === "active" &&
            connection.healthStatus === "ok" &&
            connection.credentialPolicy === "per_user" &&
            grants.grants.filter(
              (g) =>
                g.kind === "user" &&
                g.subjectUserId === state.humanId &&
                g.status === "active",
            ).length === 1 &&
            !grants.grants.some(
              (g) => g.kind === "organization" && g.status === "active",
            );
          const effective =
            await ctx.input.api.get<ToolProfileEffectiveSummary>(
              `${root(ctx)}/tools/profiles/effective/agents/${ctx.input.fixtures.agent.id}`,
            );
          const catalog = await ctx.input.api.get<{
            catalog: Array<{ id: string; isReadOnly: boolean }>;
          }>(`/api/tool-connections/${receipt.connectionId}/catalog`);
          state.readEntryIds = catalog.catalog
            .filter(
              (e) =>
                e.isReadOnly &&
                effective.allowedTools.some((t) => t.id === e.id),
            )
            .map((e) => e.id);
        }
        if (typeof state.sharedConnectionId === "string")
          state.sharedAuthorityPreserved =
            JSON.stringify(
              await sharedNotionAuthority(ctx, state.sharedConnectionId),
            ) === JSON.stringify(state.sharedAuthorityBefore);
        state.decisions = await Promise.all(
          (await ctx.allRuns()).map((run) =>
            ctx.input.api.get<ToolRunDecisionLookup>(
              `${root(ctx)}/tools/runs/${run.id}/decisions`,
            ),
          ),
        );
        state.currentHumanPreserved =
          (
            await ctx.input.api.get<{ user: { id: string } }>(
              "/api/auth/get-session",
            )
          ).user.id === state.humanId;
        state.originalSourcePreserved = ctx.issue()?.id === state.sourceIssueId;
        const current = await readNotionFixturePages(ctx),
          before = state.pages as NotionPageOracle[];
        state.pagesUnchanged =
          current.length === before.length &&
          current.every(
            (p, n) =>
              p.id === before[n]?.id &&
              p.editedAt === before[n]?.editedAt &&
              p.marker === before[n]?.marker,
          );
        return { ...o, state };
      },
      async verifyResult(ctx, state, value) {
        await verifyRenderedReply(ctx, value, String(state.initialRunId));
        const o = externalObservation(value)!,
          page = (state.pages as NotionPageOracle[])[0]!;
        const href = o.links.find((link) =>
          notionPageIdentityMatches(link, page.id),
        );
        if (!href)
          throw new Error(
            "Actual current Notion source link absent from resumed summary",
          );
        await expect(
          ctx.input.page
            .locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`)
            .first(),
        ).toBeVisible();
        await ctx.input.evidence("chat-catalog-notion-human-setup.json", {
          scenarioId: ctx.scenario.id,
          intentId: state.intentId,
          sourceIssueId: state.sourceIssueId,
          initialRunId: state.initialRunId,
          connectionId: state.connectionId,
          oauth: state.oauthReceipt,
          draft: state.savedDraft,
          currentHumanPreserved: state.currentHumanPreserved,
          originalSourcePreserved: state.originalSourcePreserved,
        });
      },
      async cleanup(ctx) {
        for (const row of (
          await ctx.input.api.get<{ connections: ToolConnection[] }>(
            `${root(ctx)}/tools/connections`,
          )
        ).connections)
          await ctx.input.api.delete(`/api/tool-connections/${row.id}`, {
            allowNotFound: true,
          });
      },
    },
  ),
);
