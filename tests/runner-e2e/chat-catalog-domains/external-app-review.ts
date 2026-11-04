import { createHash } from "node:crypto";
import { chatQueryWithAttachments, uploadFactualQueryAttachment, verifyChatQueryAttachments, type ChatQueryAttachmentReceipt, type ChatQueryHumanComment } from "../chat-query-attachments.js";
import { expect } from "@playwright/test";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { RequestConfirmationInteraction } from "../../../packages/shared/src/types/issue.js";
import type { ToolRunDecisionLookup } from "../../../packages/shared/src/types/tool-access.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import {
  connectNotes,
  startNotesProvider,
  type NotesProvider,
} from "./external-provider.js";
import { probeReviewApproval } from "./external-app-review-probe.js";
import { reviewOutcomeReply } from "./external-app-review-outcomes.js";
import { observeReviewAdmission, reviewAdmissionSummary } from "./external-app-review-diagnostic.js";
import { openStandingChat } from "./identity-support.js";
import {
  definition,
  root,
  checks,
  externalObservation,
  observeExternal,
  verifyRenderedReply,
} from "./external-support.js";
import { collectRunEvents } from "../run-observations.js";
import {
  privateScanJson,
  scanReachableSecretOutputs,
  bytesContainSecret,
} from "./external-secret-scan.js";
const providers = new WeakMap<ChatCatalogContext, NotesProvider>();
type Phase = {
  kind: "rejected" | "failed" | "executed";
  interactionId: string;
  actionRequestId: string;
  invocationId: string;
  requestRunId: string;
  replyRunId: string;
  beforeWrites: number;
  afterWrites: number;
  writtenAfter: string | null;
  reviewVisible: boolean;
  proposalVisible: boolean;
  reviewedText: string;
  reviewedArgumentsHash: string;
  providerWriteText: string | null;
  providerAuthorized: boolean | null;
  displayedScope?: string;
  toolName: string;
  applicationId: string | null;
};
interface TrustRule {
  id: string;
  companyId: string;
  policyType: string;
  enabled: boolean;
  selectors: Record<string, unknown>;
  createdByUserId?: string;
  createdByAgentId?: string | null;
  config?: {
    trustRule?: {
      sourceActionRequestId?: string;
      sourceInvocationId?: string;
      argumentFilters?: { allowAny?: boolean };
    };
  };
}
export function launchUpdateFact(text: string) {
  return (
    /launch/i.test(text) &&
    /2030/.test(text) &&
    (/\bNov(?:ember)?\s+8\b|\b8\s+Nov(?:ember)?\b/i.test(text) ||
      /2030-11-08/.test(text))
  );
}
/** The redacted JSON must still contain this fixture's complete immutable
 * single-text proposal. A short summary or an unrelated original draft is not
 * sufficient authority to approve the proposed write. */
export function appReviewProposal(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const action = value as { argumentsSummaryJson?: unknown; argumentsHash?: unknown };
  if (typeof action.argumentsSummaryJson !== "string" || action.argumentsSummaryJson.length > 20_000
    || typeof action.argumentsHash !== "string" || !/^[a-f0-9]{64}$/.test(action.argumentsHash)) return undefined;
  try {
    const args = JSON.parse(action.argumentsSummaryJson) as { text?: unknown };
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1
      || typeof args.text !== "string" || !launchUpdateFact(args.text)) return undefined;
    const expected = createHash("sha256").update(JSON.stringify({ text: args.text })).digest("hex");
    return expected === action.argumentsHash ? { text: args.text, summary: action.argumentsSummaryJson, hash: expected } : undefined;
  } catch { return undefined; }
}

export { reviewOutcomeReply } from "./external-app-review-outcomes.js";

export function exactReviewedTrust(
  rule: TrustRule,
  phase: Phase,
  state: Record<string, unknown>,
) {
  const expected: Record<string, unknown> = {
    agentId: state.leadId,
    projectId: state.projectId,
    connectionId: state.connectionId,
    toolName: phase.toolName,
    ...(phase.applicationId ? { applicationId: phase.applicationId } : {}),
  };
  return (
    rule.companyId === state.companyId &&
    rule.policyType === "trust_rule" &&
    rule.enabled === true &&
    rule.createdByUserId === state.personId &&
    !rule.createdByAgentId &&
    !!rule.selectors &&
    typeof rule.selectors === "object" &&
    Object.keys(rule.selectors).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) => rule.selectors[key] === value,
    ) &&
    rule.config?.trustRule?.sourceActionRequestId === phase.actionRequestId &&
    rule.config.trustRule.sourceInvocationId === phase.invocationId &&
    rule.config.trustRule.argumentFilters?.allowAny === true
  );
}
/** This is the disposable human draft, not an instruction to use a tool or
 * approval policy. Its actual upload supplies the canonical query's “this”. */
export function appReviewDraft(connectionId: string) {
  return `# Launch update\n\nDestination: Synthetic Launch Notes, launch page (connection ${connectionId}).\n\nThe public launch is November 8, 2030.\n`;
}

export function reviewQueriesMatch(queries: string[], original: unknown, receipt: unknown) {
  if (typeof original !== "string" || !receipt || typeof receipt !== "object") return false;
  const file = receipt as ChatQueryAttachmentReceipt;
  return file.originalFilename === "launch-update.md" && typeof file.id === "string"
    && file.contentPath === `/api/attachments/${file.id}/content`
    && queries.length === 3 && queries[0] === chatQueryWithAttachments(original, [file])
    && queries[1] === original && queries[2] === original;
}

export function gradeAppReview(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "real-three-phase-review",
    !!o,
    "Distinct human rejection, approve-once service failure and scoped Always allow success require actual persisted phases.",
  );
  if (!o) return c.result();
  const phases = o.state.phases as Phase[] | undefined,
    rows = o.state.decisions as ToolRunDecisionLookup[] | undefined;
  c.add(
    "three-actual-intents-and-human-only-resolution",
    Array.isArray(phases) &&
      phases.length === 3 &&
      ["rejected", "failed", "executed"].every(
        (kind, index) => phases[index]?.kind === kind,
      ) &&
      new Set(phases?.map((row) => row.interactionId)).size === 3 &&
      new Set(phases?.map((row) => row.requestRunId)).size === 3 &&
      new Set(phases?.map((row) => row.replyRunId)).size === 3 &&
      o.state.agentApproveStatus === 403 &&
      o.state.agentApproveCode === "interaction_governed_action_denied" &&
      o.state.agentProbeBoundaryUnchanged === true && o.state.agentProbeKeyRevoked === true &&
      reviewQueriesMatch(o.humanQueries, o.state.originalQuery, o.state.factualContextAttachment) &&
      o.state.factualContextVerified === true,
    "Each unchanged explicit human request gets one distinct actual action review; the agent cannot approve its own request.",
  );
  if (!Array.isArray(phases) || phases.length !== 3) return c.result();
  c.add(
    "scoped-visible-reviews-and-distinct-provider-outcomes",
    Array.isArray(rows) &&
      phases.every((phase, index) => {
        const card = o.interactions.find(
          (row) => row.id === phase.interactionId,
        ) as unknown as RequestConfirmationInteraction | undefined;
        const decision = rows
          .flatMap((row) =>
            Array.isArray(row?.decisions) ? row.decisions : [],
          )
          .find((row) => row?.invocation?.id === phase.invocationId);
        const v = decision?.invocation,
          request = decision?.actionRequest,
          proposal = appReviewProposal(card?.payload.toolAction);
        return (
          phase.reviewVisible && phase.proposalVisible && !!proposal
          && phase.reviewedText === proposal.text && phase.reviewedArgumentsHash === proposal.hash
          && v?.argumentsHash === proposal.hash && request?.canonicalArgumentsHash === proposal.hash
          && (index === 0 ? phase.providerWriteText === null && phase.providerAuthorized === null
            : phase.providerWriteText === proposal.text && phase.providerAuthorized === true) &&
          !!card &&
          card.kind === "request_confirmation" &&
          card.sourceRunId === phase.requestRunId &&
          card.payload.toolAction?.connectionId === o.state.connectionId &&
          card.payload.toolAction?.actionRequestId === phase.actionRequestId &&
          card.payload.toolAction?.risk === "write" &&
          card.payload.toolAction?.toolDisplayName === "Update launch page" &&
          (index < 2 ||
            card.payload.toolAction?.rememberActionScope ===
              phase.displayedScope) &&
          card.status === (index === 0 ? "rejected" : "accepted") &&
          card.resolvedByUserId === o.state.personId &&
          !card.resolvedByAgentId &&
          v?.runId === phase.requestRunId &&
          v.companyId === o.companyId &&
          v.agentId === o.leadId &&
          v.issueId === o.state.sourceId &&
          v.connectionId === o.state.connectionId &&
          v.toolName === phase.toolName &&
          v.catalogEntryId === o.state.writeEntryId &&
          request?.id === phase.actionRequestId &&
          request.status === ["rejected", "failed", "executed"][index] &&
          v.status === ["denied", "failed", "succeeded"][index] &&
          (index !== 1 || v.errorCode === "tool_execution_failed") &&
          phase.beforeWrites === [0, 0, 1][index] &&
          phase.afterWrites === [0, 1, 2][index] &&
          (index < 2
            ? phase.writtenAfter === null
            : phase.writtenAfter === phase.reviewedText && launchUpdateFact(phase.writtenAfter ?? ""))
        );
      }),
    "Actual card/human/run/task/catalog and action-request outcomes independently bind rejection/no call, service failure/no change, and successful exact launch update; no human action rescues a different requested resource.",
  );
  c.add(
    "phase-specific-truthful-model-continuations",
    phases.every((phase) =>
      o.phaseReplies.some(
        (reply) =>
          reply.runId === phase.replyRunId &&
          reviewOutcomeReply(reply.body, phase.kind) &&
          o.runs.some(
            (run) =>
              run.id === reply.runId &&
              run.agentId === o.leadId &&
              run.status === "succeeded" &&
              run.contextSnapshot?.source === "tool_action_review" &&
              Array.isArray(run.contextSnapshot.toolActionRequestIds) &&
              run.contextSnapshot.toolActionRequestIds.includes(
                phase.actionRequestId,
              ),
          ),
      ),
    ),
    "Every outcome explanation belongs to its own actual production review-delivery continuation; aggregate prose cannot hide a wrong phase.",
  );
  const rules = o.state.trustRules as TrustRule[] | undefined,
    last = phases[2]!;
  c.add(
    "only-the-displayed-always-allow-scope",
    !!last.displayedScope &&
      /this agent.*this action.*this connection.*this project/i.test(
        last.displayedScope,
      ) &&
      Array.isArray(rules) &&
      rules.length === 1 &&
      exactReviewedTrust(rules[0]!, last, o.state) &&
      o.state.rulesAfterRejection === 0 &&
      o.state.rulesAfterOnce === 0 &&
      o.state.readAllowed === true &&
      o.state.writeAskFirst === true,
    "The actual menu's agent/action/connection/project description agrees with the sole exact persisted human-created trust rule. Decline/approve-once create none; base read/Ask-first policy stays unchanged.",
  );
  c.add(
    "no-provider-credential-in-public-output",
    o.state.privateScanComplete === true && o.state.privateLeaked === false,
    "Actual raw native and reachable source/child document, revision, attachment and artifact bytes are scanned privately for the provider credential.",
  );
  return c.result();
}
async function settled(ctx: ChatCatalogContext, count: number) {
  return pollUntil({
    label: "phase-bound tool review continuation",
    deadlineAt: Date.now() + 150000,
    intervalMs: 500,
    load: async () => {
      await ctx.refreshIssue();
      return ctx.allRuns();
    },
    accept: (rows) =>
      rows.length === count &&
      rows.every((row) => row.status === "succeeded") &&
      ctx.issue()?.conversationState === "waiting",
    reject: (rows) =>
      rows.length > count ||
      rows.some((row) =>
        ["failed", "cancelled", "timed_out"].includes(row.status),
      )
        ? "Tool review phase exceeded its actual native outcome bound"
        : undefined,
  });
}
export const appReviewExternalCases = [
  definition(
    "app-permissions.ask-before-action",
    async (ctx) => {
      const provider = await startNotesProvider("Controlled launch page", {
        nonDestructiveWrites: true,
      });
      providers.set(ctx, provider);
      try {
        const connection = await connectNotes(ctx, provider, "ask-first");
        provider.failWrites();
        const agentPath = `/api/agents/${ctx.input.fixtures.agent.id}`;
        const agent = await ctx.input.api.get<{
          runtimeConfig: { heartbeat?: Record<string, unknown>; [key: string]: unknown };
        }>(agentPath);
        await ctx.input.api.patch(agentPath, {
          runtimeConfig: {
            ...agent.runtimeConfig,
            heartbeat: { ...agent.runtimeConfig.heartbeat, maxDailyRuns: 6 },
          },
        });
        const savedAgent = await ctx.input.api.get<typeof agent>(agentPath);
        if (savedAgent.runtimeConfig.heartbeat?.maxDailyRuns !== 6)
          throw new Error("Tool review fixture requires its declared six-turn daily allowance");
        const project = await ctx.input.api.post<{ id: string }>(
            `${root(ctx)}/projects`,
            { name: "Launch notes review", status: "in_progress" },
          ),
          source = await openStandingChat(ctx),
          session = await ctx.input.api.get<{ user: { id: string } }>(
            "/api/auth/get-session",
          );
        await ctx.input.api.patch(`/api/issues/${source.id}`, {
          projectId: project.id,
        });
        if (
          (
            await ctx.input.api.get<{ trustRules: unknown[] }>(
              `${root(ctx)}/tools/trust-rules`,
            )
          ).trustRules.length
        )
          throw new Error(
            "Tool review fixture requires no existing trust grant",
          );
        if (!session.user?.id || session.user.id === "local-board")
          throw new Error("Tool review needs an actual signed-in human");
        const factualContextAttachment = await uploadFactualQueryAttachment(ctx, {
          filename: "launch-update.md", body: appReviewDraft(connection.connectionId),
        });
        if (factualContextAttachment.issueId !== source.id) throw new Error("Launch draft was uploaded to another conversation");
        return {
          factualContextAttachment,
          connectionId: connection.connectionId,
          writeEntryId: connection.write[0],
          projectId: project.id,
          sourceId: source.id,
          companyId: ctx.input.fixtures.company.id,
          leadId: ctx.input.fixtures.agent.id,
          personId: session.user.id,
          originalQuery: ctx.scenario.query,
          phases: [],
        };
      } catch (error) {
        providers.delete(ctx);
        await provider.close();
        throw error;
      }
    },
    gradeAppReview,
    {
      authentication: "human-session",
      oracleVersion: "paperclip.chat-catalog.app-review.v6",
      queryAttachments: [{ stateKey: "factualContextAttachment", filename: "launch-update.md" }],
      expectedRunCount: 6,
      minimumRunCount: 6,
      expectedHumanMessageCount: 3,
      attemptTimeoutMs: 1140000,
      sourceFiles: [
        "chat-catalog-domains/external-app-review.ts",
        "chat-catalog-domains/external-app-review-outcomes.ts",
        "chat-catalog-domains/external-app-review-probe.ts",
        "chat-catalog-domains/external-app-review-diagnostic.ts",
        "../../packages/shared/src/validators/issue.ts",
        "chat-catalog-domains/external-provider.ts",
        "chat-catalog-domains/identity-support.ts",
        "chat-catalog-domains/external-secret-scan.ts",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-flow.ts",
        "chat-query-attachments.ts",
        "run-observations.ts",
        "../../server/src/routes/issues.ts",
        "../../server/src/routes/tool-access.ts",
        "../../server/src/services/tool-gateway.ts",
        "../../server/src/services/tool-action-replay-intent.ts",
        "../../server/src/services/tool-action-review.ts",
        "../../server/src/services/tool-action-delivery.ts",
        "../../server/src/services/tool-access-policy.ts",
        "../../ui/src/components/IssueThreadInteractionCard.tsx",
        "../../ui/src/components/task-chat/TaskChatInteractionCard.tsx",
        "../../ui/src/components/task-chat/TaskChatComposer.tsx",
        "chat-scenarios/app-permissions.yaml",
      ],
      async act(ctx, state) {
        const provider = providers.get(ctx)!,
          phases = state.phases as Phase[];
        for (const [index, kind] of (
          ["rejected", "failed", "executed"] as const
        ).entries()) {
          if (index) await sendChatMessage(ctx.input.page, ctx.scenario.query);
          const cards = await pollUntil({
            label: "new actual requested launch-write review",
            deadlineAt: Date.now() + 150000,
            intervalMs: 500,
            load: () =>
              ctx.input.api.get<RequestConfirmationInteraction[]>(
                `/api/issues/${state.sourceId}/interactions`,
              ),
            accept: (rows) =>
              rows.filter(
                (row) =>
                  row.status === "pending" &&
                  row.payload?.toolAction?.connectionId === state.connectionId,
              ).length === 1,
            reject: () =>
              provider.calls.filter((row) => row.name === "launch_update")
                .length !== [0, 0, 1][index]
                ? "Provider write preceded this invocation's human review"
                : undefined,
          });
          const card = cards.find(
              (row) =>
                row.status === "pending" &&
                row.payload?.toolAction?.connectionId === state.connectionId,
            )!,
            action = card.payload.toolAction!,
            proposal = appReviewProposal(action);
          if (
            !card.sourceRunId ||
            phases.some((row) => row.interactionId === card.id) ||
            action.toolDisplayName !== "Update launch page" ||
            action.risk !== "write" ||
            !action.rememberActionScope ||
            !proposal
          )
            throw new Error(
              "Actual review must identify the selected update action and substantive launch fact before human action",
            );
          const requestRuns = await settled(ctx, index * 2 + 1),
            known = new Set(
              phases.flatMap((row) => [row.requestRunId, row.replyRunId]),
            ),
            newRuns = requestRuns.filter((row) => !known.has(row.id));
          if (
            newRuns.length !== 1 ||
            newRuns[0]?.id !== card.sourceRunId ||
            newRuns[0].contextSnapshot?.issueId !== state.sourceId
          )
            throw new Error(
              "New canonical request must independently bind exactly one new pending-action source run",
            );
          const pending = await ctx.input.api.get<ToolRunDecisionLookup>(`${root(ctx)}/tools/runs/${card.sourceRunId}/decisions`);
          const intended = pending.decisions.find(row => row.invocation.id === action.invocationId);
          if (pending.runId !== card.sourceRunId || !intended || intended.invocation.companyId !== state.companyId
            || intended.invocation.agentId !== state.leadId || intended.invocation.issueId !== state.sourceId
            || intended.invocation.runId !== card.sourceRunId || intended.invocation.connectionId !== state.connectionId
            || intended.invocation.catalogEntryId !== state.writeEntryId || intended.invocation.status !== "awaiting_approval"
            || intended.invocation.argumentsHash !== proposal.hash || intended.actionRequest?.id !== action.actionRequestId
            || intended.actionRequest.status !== "pending" || intended.actionRequest.canonicalArgumentsHash !== proposal.hash)
            throw new Error("Full proposal must bind the actual pending owned invocation before human action");
          const phase: Phase = {
            kind,
            interactionId: card.id,
            actionRequestId: action.actionRequestId,
            invocationId: action.invocationId,
            requestRunId: card.sourceRunId,
            replyRunId: "",
            beforeWrites: provider.calls.filter(
              (row) => row.name === "launch_update",
            ).length,
            afterWrites: -1,
            writtenAfter: null,
            reviewVisible: false,
            proposalVisible: false,
            reviewedText: proposal.text,
            reviewedArgumentsHash: proposal.hash,
            providerWriteText: null,
            providerAuthorized: null,
            toolName: action.toolName,
            applicationId: action.applicationId,
          };
          const timeline = ctx.input.page.locator(
            `[id=${JSON.stringify(`interaction-${card.id}`)}]`,
          );
          await expect(timeline).toBeVisible();
          // The timeline is a preview. Open this exact pending request before
          // using the production decision controls in the composer takeover.
          await timeline.getByRole("button", { name: "Review request", exact: true }).click();
          const view = ctx.input.page.getByTestId("task-chat-composer-takeover");
          await expect(view).toBeVisible();
          await expect(view.getByRole("img", { name: action.appDisplayName || action.toolDisplayName, exact: true })).toBeVisible();
          await expect(view).toContainText("Update launch page");
          phase.reviewVisible = true;
          const details = view.locator("details").filter({ hasText: "Arguments and audit hash" });
          await expect(details).toBeVisible();
          await details.locator("summary").click();
          const proposedArguments = details.locator("pre");
          await expect(proposedArguments).toBeVisible();
          if (await proposedArguments.textContent() !== proposal.summary || await details.locator("p").textContent() !== proposal.hash)
            throw new Error("Normal review disclosure must expose this exact immutable full proposal and hash");
          phase.proposalVisible = true;
          if (index === 0) {
            const probe = await probeReviewApproval({
              baseURL: ctx.input.api.baseURL, companyId: state.companyId as string,
              agentId: state.leadId as string, issueId: state.sourceId as string,
              interaction: card, run: newRuns[0]!, invocation: intended.invocation,
              privateSecrets: ctx.input.privateSecrets!,
              createKey: () => ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${state.leadId}/keys`, { name: `chat-review-probe-${ctx.input.nonce}` }),
              revokeKey: id => ctx.input.api.delete(`/api/agents/${state.leadId}/keys/${id}`),
              boundary: async () => {
                const [currentCards, current, rules] = await Promise.all([
                  ctx.input.api.get<RequestConfirmationInteraction[]>(`/api/issues/${state.sourceId}/interactions`),
                  ctx.input.api.get<ToolRunDecisionLookup>(`${root(ctx)}/tools/runs/${card.sourceRunId}/decisions`),
                  ctx.input.api.get<{ trustRules: TrustRule[] }>(`${root(ctx)}/tools/trust-rules`),
                ]);
                const owned = current.decisions.find(row => row.invocation.id === action.invocationId);
                const ownedCard = currentCards.find(row => row.id === card.id);
                if (!owned || current.runId !== card.sourceRunId || ownedCard?.sourceRunId !== card.sourceRunId
                  || owned?.invocation.companyId !== state.companyId || owned.invocation.agentId !== state.leadId
                  || owned.invocation.issueId !== state.sourceId || owned.invocation.runId !== card.sourceRunId
                  || owned.invocation.argumentsHash !== proposal.hash || owned.actionRequest?.id !== action.actionRequestId
                  || owned.actionRequest.canonicalArgumentsHash !== proposal.hash)
                  throw new Error("Approval probe changed the owned pending source or immutable proposal");
                return { interactionStatus: ownedCard?.status ?? "missing",
                  invocationStatus: owned?.invocation.status ?? "missing", actionStatus: owned?.actionRequest?.status ?? "missing",
                  providerWrites: provider.calls.filter(row => row.name === "launch_update").length,
                  trustRuleIds: rules.trustRules.map(row => row.id) };
              },
            });
            state.agentApproveStatus = probe.status;
            state.agentApproveCode = probe.code;
            state.agentProbeBoundaryUnchanged = probe.boundaryUnchanged;
            state.agentProbeKeyRevoked = probe.keyRevoked;
            await ctx.input.evidence("app-review-agent-approval-probe.json", probe);
            if (probe.status !== 403 || probe.code !== "interaction_governed_action_denied" || !probe.boundaryUnchanged || !probe.keyRevoked)
              throw new Error(`Agent approval probe did not prove governed-action authorization: ${probe.status}/${probe.code}`);
            await view
              .getByRole("button", { name: "Decline", exact: true })
              .click();
          } else if (index === 1)
            await view
              .getByRole("button", { name: "Approve & run", exact: true })
              .click();
          else {
            provider.allowWrites();
            await view
              .getByRole("button", { name: "Approval options", exact: true })
              .click();
            const option = ctx.input.page.getByRole("menuitem", {
              name: "Always allow",
              exact: true,
            });
            phase.displayedScope =
              (await option.getAttribute("aria-description")) ?? undefined;
            if (phase.displayedScope !== action.rememberActionScope)
              throw new Error(
                "Actual displayed always-allow scope differs from the requested action",
              );
            await option.click();
          }
          let runs: Awaited<ReturnType<typeof settled>>;
          try { runs = await settled(ctx, index * 2 + 2); }
          catch (error) {
            // Observe only the exact failed review phase. This cannot resume,
            // settle or regrade it; the original wait failure remains authoritative.
            try {
              const snapshot = await observeReviewAdmission({ companyId: String(state.companyId), issueId: String(state.sourceId),
                agentId: String(state.leadId), actionRequestId: phase.actionRequestId, invocationId: phase.invocationId,
                interactionId: phase.interactionId, sourceRunId: phase.requestRunId });
              await ctx.input.evidence(`chat-catalog-app-review-admission-${index + 1}.json`, snapshot).catch(() => {});
              console.log("App review admission diagnostic", JSON.stringify(reviewAdmissionSummary(snapshot)));
            } catch { /* Diagnostic failure cannot replace the original failure. */ }
            throw error;
          }
          const reply = runs.find(
              (row) =>
                row.contextSnapshot?.source === "tool_action_review" &&
                Array.isArray(row.contextSnapshot.toolActionRequestIds) &&
                row.contextSnapshot.toolActionRequestIds.includes(
                  action.actionRequestId,
                ),
            );
          if (!reply)
            throw new Error(
              "Actual tool-review delivery did not bind this request's own continuation",
            );
          phase.replyRunId = reply.id;
          phase.afterWrites = provider.calls.filter(
            (row) => row.name === "launch_update",
          ).length;
          phase.writtenAfter = provider.written() ?? null;
          const writes = provider.calls.filter(row => row.name === "launch_update");
          const dispatched = index > 0 ? writes.at(-1) : undefined;
          phase.providerWriteText = typeof dispatched?.arguments?.text === "string" ? dispatched.arguments.text : null;
          phase.providerAuthorized = dispatched ? dispatched.authorized : null;
          if (index === 0 ? writes.length !== 0 : phase.providerWriteText !== phase.reviewedText || phase.providerAuthorized !== true)
            throw new Error("Actual provider dispatch differs from the exact human-reviewed proposal");
          phases.push(phase);
          const rules = await ctx.input.api.get<{ trustRules: unknown[] }>(
            `${root(ctx)}/tools/trust-rules`,
          );
          if (index === 0) state.rulesAfterRejection = rules.trustRules.length;
          if (index === 1) state.rulesAfterOnce = rules.trustRules.length;
          const current = (
              await ctx.input.api.get<RequestConfirmationInteraction[]>(
                `/api/issues/${state.sourceId}/interactions`,
              )
            ).find((row) => row.id === card.id),
            decisions = await ctx.input.api.get<ToolRunDecisionLookup>(
              `${root(ctx)}/tools/runs/${phase.requestRunId}/decisions`,
            ),
            actual = decisions.decisions.find(
              (row) => row.invocation.id === phase.invocationId,
            );
          if (
            !actual ||
            actual.actionRequest?.status !==
              ["rejected", "failed", "executed"][index] ||
            actual.invocation.status !==
              ["denied", "failed", "succeeded"][index] ||
            actual.invocation.catalogEntryId !== state.writeEntryId ||
            current?.status !== (index === 0 ? "rejected" : "accepted") ||
            current.resolvedByUserId !== state.personId ||
            phase.afterWrites !== [0, 1, 2][index] ||
            (index < 2
              ? phase.writtenAfter !== null
              : phase.writtenAfter !== phase.reviewedText || !launchUpdateFact(phase.writtenAfter ?? ""))
          )
            throw new Error(
              "Actual action/card/provider outcome did not settle correctly before the next human request",
            );
          await ctx.input.evidence(
            `chat-catalog-app-review-phase-${index + 1}.json`,
            {
              phase,
              cardStatus: current.status,
              resolvedByUserId: current.resolvedByUserId,
              requestStatus: actual.actionRequest.status,
              invocationStatus: actual.invocation.status,
              errorCode: actual.invocation.errorCode,
              trustRuleCount: rules.trustRules.length,
            },
          );
          const observed = await observeExternal(ctx, state),
            body =
              observed.phaseReplies.find((row) => row.runId === reply.id)
                ?.body ?? "";
          if (!reviewOutcomeReply(body, kind))
            throw new Error(
              "Actual model continuation confused rejection, provider failure or scoped successful execution",
            );
        }
      },
      async observe(ctx, state) {
        state.decisions = await Promise.all(
          (await ctx.allRuns()).map((run) =>
            ctx.input.api.get<ToolRunDecisionLookup>(
              `${root(ctx)}/tools/runs/${run.id}/decisions`,
            ),
          ),
        );
        state.trustRules = (
          await ctx.input.api.get<{ trustRules: TrustRule[] }>(
            `${root(ctx)}/tools/trust-rules`,
          )
        ).trustRules;
        const page = await ctx.input.page.context().newPage();
        try {
          await page.goto(
            `/${ctx.input.fixtures.company.issuePrefix}/apps/${state.connectionId}/permissions`,
            { waitUntil: "domcontentloaded" },
          );
          state.readAllowed = await page
            .getByRole("radio", {
              name: "Read launch page: Allowed",
              exact: true,
            })
            .isChecked();
          state.writeAskFirst = await page
            .getByRole("radio", {
              name: "Update launch page: Ask first",
              exact: true,
            })
            .isChecked();
        } finally {
          await page.close();
        }
        const humanComments = await ctx.input.api.get<ChatQueryHumanComment[]>(`/api/issues/${state.sourceId}/comments?order=asc`);
        const firstHuman = humanComments.find(comment => comment.authorUserId === state.personId && !comment.authorAgentId);
        state.factualContextVerified = !!firstHuman && await verifyChatQueryAttachments(ctx, [state.factualContextAttachment as ChatQueryAttachmentReceipt], firstHuman);
        const o = await observeExternal(ctx, state),
          provider = providers.get(ctx)!,
          ids = new Set([String(state.sourceId)]);
        for (;;) {
          const size = ids.size;
          for (const task of o.tasks)
            if (task.parentId && ids.has(task.parentId)) ids.add(task.id);
          if (size === ids.size) break;
        }
        const scan = await scanReachableSecretOutputs(
            ctx,
            [...ids],
            provider.token,
          ),
          events = [];
        for (const run of o.runs)
          events.push(
            ...(await collectRunEvents((afterSeq) =>
              privateScanJson(
                ctx,
                `/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=1000`,
              ),
            )),
          );
        state.privateScanComplete = scan.complete;
        state.privateLeaked =
          scan.leaked ||
          bytesContainSecret(
            Buffer.from(JSON.stringify([events, o.runs])),
            provider.token,
          );
        return { ...o, state };
      },
      async verifyResult(ctx, state, value) {
        await verifyRenderedReply(ctx, value);
        for (const phase of state.phases as Phase[]) {
          const card = ctx.input.page.locator(
            `[id=${JSON.stringify(`interaction-${phase.interactionId}`)}]`,
          );
          await expect(card).toContainText(
            phase.kind === "rejected"
              ? "Declined"
              : phase.kind === "failed"
                ? "Execution failed"
                : "Succeeded",
          );
          if (phase.kind === "executed")
            await expect(card).toContainText("Always allowed");
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
