import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ToolRunDecisionLookup } from "../../../packages/shared/src/types/tool-access.js";
import { pollUntil } from "../api.js";
import {
  identityWorker,
  openStandingChat,
  probeAgentPermission,
} from "./identity-support.js";
import {
  connectNotes,
  startNotesProvider,
  type NotesProvider,
} from "./external-provider.js";
import {
  definition,
  root,
  externalObservation,
  observeExternal,
  checks,
  verifyRenderedReply,
} from "./external-support.js";
import type { Entity } from "./internal-support.js";
import { collectRunEvents } from "../run-observations.js";
import { isValidNativePrpEnvelope } from "../native-event-envelope.js";
import { privateScanJson } from "./external-secret-scan.js";

import { observedRedactedPublicReceipt } from "./gateway-public-receipt.js";
const providers = new WeakMap<ChatCatalogContext, NotesProvider>();
type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
export function observedMorganReceiptRead(events: Row[], report: Entity) {
  const rows = events.flatMap((event) => {
    const envelope = object(event.payload).prpEvent;
    return isValidNativePrpEnvelope(
      object(envelope),
      event.protocolSchemaVersion,
    ) && object(envelope).sourceKind === "runner"
      ? [{ event, payload: object(object(envelope).payload) }]
      : [];
  });
  const contains = (value: unknown, depth = 0): boolean => {
    if (depth > 12) return false;
    if (Array.isArray(value))
      return value.slice(0, 1000).some((row) => contains(row, depth + 1));
    const row = object(value);
    if (
      row.id === report.id &&
      row.issueId === report.issueId &&
      row.authorAgentId === report.authorAgentId &&
      row.createdByRunId === report.createdByRunId &&
      row.body === report.body
    )
      return true;
    return Object.values(row).some((child) => contains(child, depth + 1));
  };
  return rows.some(({ event, payload }) => {
    const item = object(payload.item);
    if (
      event.eventType !== "item.completed" ||
      item.type !== "tool_result" ||
      typeof item.id !== "string" ||
      !contains(item.result)
    )
      return false;
    const start = rows.find(
      (row) =>
        row.event.eventType === "item.started" &&
        Number(row.event.seq) < Number(event.seq) &&
        object(row.payload.item).id === item.id,
    );
    if (
      !start ||
      !JSON.stringify(object(start.payload.item).input).includes(
        String(report.issueId),
      )
    )
      return false;
    return rows.some(
      (row) =>
        row.event.eventType === "tool.execution.completed" &&
        row.payload.executionId === item.id &&
        row.payload.status === "completed" &&
        Number(row.event.seq) > Number(start.event.seq),
    );
  });
}
/** Accept a bounded provider diagnosis from the permitted Morgan task receipt,
 * or an honest handoff to the human audit. The CEO's separate receipt is never
 * evidence of Morgan's invocation or a complete company history. */
export function gatewayErrorAnswer(reply: string) {
  const clauses = reply
    .split(/[.!?;\n]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const falseClaim = clauses.some(
    (clause) =>
      !/\b(?:not|cannot|can't|don't|doesn't|isn't|is not|no evidence|unknown|unconfirmed|may|might|could)\b/i.test(
        clause,
      ) &&
      (/\b(?:I|we)(?:['’]ve| have)?\s+(?:already\s+)?(?:reviewed|checked|inspected|queried)\b.*\b(?:all|company.?wide|entire)\b.*\b(?:audit|history|activity|gateway)/i.test(
        clause,
      ) ||
        /\b(?:my|own)\s+(?:receipt|call|invocation)\b.*\b(?:proves|shows|represents|covers)\b.*\b(?:Morgan|all|company)/i.test(
          clause,
        ) ||
        /\b(?:Morgan|notes|tool|call)\b.*\b(?:failed|blocked|denied)\b.*\b(?:because|due to)\b.*\b(?:policy|permission|discovery|not installed|not connected)/i.test(
          clause,
        )),
  );
  const provider =
    /\b(?:provider|upstream|synthetic write)\b[^.!?\n]{0,100}\b(?:error|fail|unchanged)|\b(?:error|fail)\w*\b[^.!?\n]{0,100}\b(?:provider|upstream)/i.test(
      reply,
    );
  const handoff =
    /\b(?:human|board|operator|authorized|you)\b[^.!?\n]{0,120}\b(?:audit|activity|receipt)/i.test(
      reply,
    ) &&
    /\b(?:cannot|can't|don't have|not authorized|limited|need|requires|check|open|review)\b/i.test(
      reply,
    );
  return /\bMorgan\b/i.test(reply) && !falseClaim && (provider || handoff);
}
function failedInvocation(
  rows: ToolRunDecisionLookup[],
  runId: unknown,
  agentId: unknown,
  issueId: unknown,
  state: Record<string, unknown>,
) {
  return rows.some(
    (row) =>
      row.runId === runId &&
      row.decisions.some(
        ({ invocation: v, auditEvents }) =>
          v.runId === runId &&
          v.agentId === agentId &&
          v.issueId === issueId &&
          v.companyId === state.companyId &&
          v.connectionId === state.connectionId &&
          v.catalogEntryId === state.writeEntryId &&
          v.status === "failed" &&
          v.errorCode === "tool_error" &&
          auditEvents.some(
            (event) =>
              event.invocationId === v.id &&
              event.runId === runId &&
              event.outcome === "failure",
          ),
      ),
  );
}
export function gradeGatewayError(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "actual-independent-diagnostic-context",
    !!o,
    "Distinct real native tool failures and their public task receipts are required.",
  );
  if (!o) return c.result();
  const rows = o.state.decisions as ToolRunDecisionLookup[] | undefined;
  c.add(
    "two-distinct-agent-task-provider-failures",
    !!rows &&
      o.state.morganId !== o.leadId &&
      o.state.morganRunId !== o.state.ownRunId &&
      o.state.morganTaskId !== o.state.ownTaskId &&
      failedInvocation(
        rows,
        o.state.morganRunId,
        o.state.morganId,
        o.state.morganTaskId,
        o.state,
      ) &&
      failedInvocation(
        rows,
        o.state.ownRunId,
        o.leadId,
        o.state.ownTaskId,
        o.state,
      ) &&
      o.runs.filter((run) =>
        [o.state.morganRunId, o.state.ownRunId].includes(run.id),
      ).length === 2 &&
      o.runs
        .filter((run) =>
          [o.state.morganRunId, o.state.ownRunId].includes(run.id),
        )
        .every(
          (run) => run.runtimeMode === "native" && run.status === "succeeded",
        ) &&
      o.state.morganReceiptNativeBound === true &&
      o.state.ownReceiptNativeBound === true,
    "Board receipts bind two actual allowed provider attempts to distinct agent/task/native identities; their real task comments are authored by those runs.",
  );
  c.add(
    "provider-error-not-policy-or-discovery",
    Number(o.state.providerWrites) >= 2 &&
      Number(o.state.providerWrites) <= 4 &&
      o.state.providerAllAuthorized === true &&
      o.state.written === null,
    "The controlled MCP provider actually received the writes and returned errors without changing the page. A policy/discovery denial cannot satisfy this fixture.",
  );
  c.add(
    "company-audit-is-human-only",
    o.state.agentAuditStatus === 403 && o.state.agentDecisionStatus === 403,
    "The ordinary agent cannot query company-wide audit or board run-decision lookups.",
  );
  c.add(
    "permitted-receipt-or-truthful-human-handoff",
    gatewayErrorAnswer(o.reply) &&
      (o.state.canonicalReadMorganReceipt === true ||
        (o.state.scopedAuditLink === true &&
          /\b(?:human|board|operator|authorized|you)\b[^.!?\n]{0,120}\b(?:audit|activity)/i.test(
            o.reply,
          ))),
    "The reply reads Morgan's actual permitted task receipt or routes the authorized human to company activity, without inventing policy failures or treating its own receipt as everyone else's history.",
  );
  return c.result();
}
async function diagnostic(
  ctx: ChatCatalogContext,
  agentId: string,
  title: string,
  text: string,
) {
  const task = await ctx.input.api.post<Entity>(`${root(ctx)}/issues`, {
    title,
    status: "todo",
    assigneeAgentId: agentId,
    description: `Run one diagnostic check of the connected Synthetic Launch Notes launch_update action with text ${JSON.stringify(text)}. Do not retry or repair the provider. Report the actual tool result in this task's comment, then finish the diagnostic task; a provider failure is a valid diagnostic result.`,
  });
  const result = await pollUntil({
    label: "genuine notes diagnostic native receipt",
    deadlineAt: Date.now() + 150000,
    intervalMs: 1000,
    load: async () => ({
      runs: (await ctx.allRuns()).filter(
        (run) => run.contextSnapshot?.issueId === task.id,
      ),
      comments: await ctx.input.api.get<Entity[]>(
        `/api/issues/${task.id}/comments?order=asc`,
      ),
    }),
    accept: (v) =>
      v.runs.length === 1 &&
      v.runs[0]?.status === "succeeded" &&
      v.comments.some(
        (comment) =>
          comment.createdByRunId === v.runs[0]?.id &&
          comment.authorAgentId === agentId &&
          !!comment.body?.trim(),
      ),
    reject: (v) =>
      v.runs.length > 1 ||
      v.runs.some((run) =>
        ["failed", "cancelled", "timed_out"].includes(run.status),
      )
        ? "Prerequisite diagnostic did not yield one successful native result report"
        : undefined,
  });
  return { task, runId: result.runs[0]!.id };
}
export const gatewayErrorExternalCases = [
  definition(
    "gateways-profiles.inspect-gateway-error",
    async (ctx) => {
      const provider = await startNotesProvider(
        "Controlled notes page: diagnostic only",
      );
      providers.set(ctx, provider);
      try {
        provider.failWrites();
        const connection = await connectNotes(ctx, provider, "all"),
          morgan = await identityWorker(ctx);
        const agentIds = [ctx.input.fixtures.agent.id, morgan.id];
        await ctx.input.api.post(
          `${root(ctx)}/tools/apps/${connection.connectionId}/finish`,
          {
            enabledCatalogEntryIds: [...connection.read, ...connection.write],
            askFirstCatalogEntryIds: [],
            access: { agentIds },
          },
        );
        await ctx.input.api.putSensitive(
          `/api/tool-connections/${connection.connectionId}/installs`,
          {
            installs: agentIds.map((targetId) => ({
              targetType: "agent",
              targetId,
            })),
          },
        );
        for (const scope of [
          { scopeType: "company", scopeId: ctx.input.fixtures.company.id },
          ...agentIds.map((scopeId) => ({ scopeType: "agent", scopeId })),
        ])
          await ctx.input.api.post(`${root(ctx)}/budgets/policies`, {
            ...scope,
            amount: 500,
            hardStopEnabled: true,
            isActive: true,
            unpricedUsagePolicy: "allow",
          });
        const worker = await diagnostic(
            ctx,
            morgan.id,
            "Morgan notes diagnostic",
            "Morgan diagnostic",
          ),
          own = await diagnostic(
            ctx,
            ctx.input.fixtures.agent.id,
            "CEO notes diagnostic",
            "CEO diagnostic",
          );
        const chat = await openStandingChat(ctx);
        await ctx.input.api.patch(`/api/issues/${chat.id}`, {
          description: `The notes connection is Synthetic Launch Notes (${connection.connectionId}). Morgan's diagnostic task is ${worker.task.identifier ?? worker.task.id}. Your separate diagnostic receipt is on ${own.task.identifier ?? own.task.id}. Those are separate task-scoped reports; no company-wide board audit has been supplied to this chat.`,
        });
        return {
          companyId: ctx.input.fixtures.company.id,
          connectionId: connection.connectionId,
          writeEntryId: connection.write[0],
          morganId: morgan.id,
          morganTaskId: worker.task.id,
          morganIdentifier: worker.task.identifier,
          ownTaskId: own.task.id,
          morganRunId: worker.runId,
          ownRunId: own.runId,
          agentAuditStatus: await probeAgentPermission(
            ctx,
            `/api/tool-gateway/audit?companyId=${ctx.input.fixtures.company.id}`,
            "GET",
          ),
          agentDecisionStatus: await probeAgentPermission(
            ctx,
            `${root(ctx)}/tools/runs/${worker.runId}/decisions`,
            "GET",
          ),
        };
      } catch (error) {
        providers.delete(ctx);
        await provider.close();
        throw error;
      }
    },
    gradeGatewayError,
    {
      authentication: "human-session",
      expectedRunCount: 3,
      minimumRunCount: 3,
      expectedHumanMessageCount: 1,
      attemptTimeoutMs: 660000,
      oracleVersion: "paperclip.chat-catalog.gateway-public-receipt.v2",
      sourceFiles: [
        "chat-catalog-domains/gateway-public-receipt.ts",
        "chat-catalog-domains/external-gateway-error.ts",
        "chat-catalog-domains/external-provider.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/external-secret-scan.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-catalog-domains/identity-support.ts",
        "run-observations.ts",
        "native-event-envelope.ts",
        "../../server/src/routes/tool-gateway.ts",
        "../../server/src/routes/tool-access.ts",
        "../../server/src/services/tool-gateway.ts",
        "../../ui/src/App.tsx",
        "chat-scenarios/gateways-profiles.yaml",
      ],
      async verifySetup(ctx, state) {
        const rows = await Promise.all(
          [state.morganRunId, state.ownRunId].map((id) =>
            ctx.input.api.get<ToolRunDecisionLookup>(
              `${root(ctx)}/tools/runs/${id}/decisions`,
            ),
          ),
        );
        if (
          !failedInvocation(
            rows,
            state.morganRunId,
            state.morganId,
            state.morganTaskId,
            state,
          ) ||
          !failedInvocation(
            rows,
            state.ownRunId,
            ctx.input.fixtures.agent.id,
            state.ownTaskId,
            state,
          )
        )
          throw new Error(
            "Setup blocker: two distinct actual native provider-error receipts are required before diagnostic chat",
          );
        if (state.agentAuditStatus !== 403 || state.agentDecisionStatus !== 403)
          throw new Error(
            "Setup blocker: company audit and board receipt lookup must deny the ordinary agent",
          );
        return {
          passed: true,
          checks: [
            {
              id: "distinct-native-provider-receipts-and-board-boundary",
              passed: true,
              detail:
                "Two independently observed provider tool_error invocations bind separate agent/task native reports; company audit and decision lookup deny the ordinary agent.",
            },
          ],
        };
      },
      async observe(ctx, state) {
        const provider = providers.get(ctx)!;
        state.decisions = await Promise.all(
          (await ctx.allRuns()).map((run) =>
            ctx.input.api.get<ToolRunDecisionLookup>(
              `${root(ctx)}/tools/runs/${run.id}/decisions`,
            ),
          ),
        );
        let ascendingMorganComments: Entity[] = [];
        for (const prefix of ["morgan", "own"]) {
          const comments = await ctx.input.api.get<Entity[]>(
            `/api/issues/${state[`${prefix}TaskId`]}/comments?order=asc`,
          );
          if (prefix === "morgan") ascendingMorganComments = comments;
          state[`${prefix}ReceiptNativeBound`] = comments.some(
            (comment) =>
              comment.createdByRunId === state[`${prefix}RunId`] &&
              comment.authorAgentId ===
                (prefix === "morgan"
                  ? state.morganId
                  : ctx.input.fixtures.agent.id) &&
              /fail|error|unchanged/i.test(comment.body ?? ""),
          );
        }
        const calls = provider.calls.filter(
          (call) =>
            call.method === "tools/call" && call.name === "launch_update",
        );
        state.providerWrites = calls.length;
        state.providerAllAuthorized = calls.every((call) => call.authorized);
        state.written = provider.written() ?? null;
        const o = await observeExternal(ctx, state),
          prefix = `/${ctx.input.fixtures.company.issuePrefix}`;
        state.scopedAuditLink = o.links.some((href) => {
          try {
            const url = new URL(href, o.origin);
            return (
              url.origin === o.origin && url.pathname === `${prefix}/activity`
            );
          } catch {
            return false;
          }
        });
        const reports = await ctx.input.api.get<Entity[]>(
            `/api/issues/${state.morganTaskId}/comments`,
          ),
          report = reports.find(
            (row) =>
              row.createdByRunId === state.morganRunId &&
              row.authorAgentId === state.morganId &&
              /fail|error|unchanged/i.test(row.body ?? ""),
          );
        state.canonicalReadMorganReceipt = false;
        if (report)
          for (const run of o.runs.filter(
            (row) => row.contextSnapshot?.issueId === ctx.issue()?.id,
          )) {
            const events = await collectRunEvents<Row>((afterSeq) =>
              privateScanJson(
                ctx,
                `/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`,
              ),
            );
            if (observedMorganReceiptRead(events, report) || observedRedactedPublicReceipt(events, object(report), reports.map(object), {
              companyId: o.companyId, leadId: o.leadId, canonicalRunId: run.id, workerId: String(state.morganId),
              workerTaskId: String(state.morganTaskId), workerRunId: String(state.morganRunId),
            }, [ascendingMorganComments.map(object)])) state.canonicalReadMorganReceipt = true;
          }
        return { ...o, state };
      },
      async verifyResult(ctx, state, value) {
        await verifyRenderedReply(ctx, value);
        const source = ctx.input.page.url();
        try {
          await ctx.input.page.goto(
            `/${ctx.input.fixtures.company.issuePrefix}/issues/${state.morganTaskId}`,
            { waitUntil: "domcontentloaded" },
          );
          await expect(
            ctx.input.page
              .getByText("Morgan notes diagnostic", { exact: true })
              .first(),
          ).toBeVisible();
          const comments = await ctx.input.api.get<Entity[]>(
            `/api/issues/${state.morganTaskId}/comments?order=asc`,
          );
          const report = comments.find(
            (row) =>
              row.createdByRunId === state.morganRunId &&
              row.authorAgentId === state.morganId &&
              /fail|error|unchanged/i.test(row.body ?? ""),
          );
          if (!report)
            throw new Error("Actual Morgan task result report missing");
          await expect(
            ctx.input.page.locator(
              `[id=${JSON.stringify(`comment-${report.id}`)}]`,
            ),
          ).toBeVisible();
        } finally {
          await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
        }
      },
      async cleanup(ctx, state) {
        try {
          if (typeof state.connectionId === "string")
            await ctx.input.api.delete(
              `/api/tool-connections/${state.connectionId}`,
              { allowNotFound: true },
            );
        } finally {
          const provider = providers.get(ctx);
          providers.delete(ctx);
          await provider?.close();
        }
      },
    },
  ),
];
