import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely } from "../chat-catalog-contract.js";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { observeInternal, observation, type Entity, type InternalObservation } from "./internal-support.js";

/** These cases exercise only the launcher-owned instance or a rendered developer fixture. */
export function privilegedDefinition(scenarioId: string, module: string, extra: Pick<ChatCatalogCase, "setup" | "grade" | "act" | "verifyResult">): ChatCatalogCase {
  return { scenarioId, oracleVersion: "paperclip.chat-catalog.privileged.v1", coverageGaps: [],
    authentication: "human-session", expectedRunCount: 1, turnTimeoutMs: 120_000, attemptTimeoutMs: 420_000,
    sourceFiles: ["chat-catalog-domains/privileged-support.ts", `chat-catalog-domains/${module}.ts`, `chat-scenarios/${scenarioId.split(".")[0]}.yaml`],
    observe: observeInternal, ...extra };
}
export function remainingPrivilegedObservationBudget(ctx: ChatCatalogContext): number {
  const deadline = ctx.observationDeadlineAt;
  const now = Date.now();
  if (!Number.isFinite(deadline) || deadline! <= now) throw new Error("Original privileged observation budget exhausted or missing");
  return deadline! - now;
}
export async function settlePrivilegedChat(ctx: ChatCatalogContext, observationDeadlineAt?: number): Promise<InternalObservation> {
  return pollUntil({ label: "Canonical privileged guidance settled", deadlineAt: chatCatalogNativePhaseDeadline(ctx, observationDeadlineAt ?? Date.now() + 150_000),
    load: () => observeInternal(ctx, {}),
    accept: o => chatCatalogNativePhaseIsTimely(ctx) && ((observationDeadlineAt === undefined || Date.now() < observationDeadlineAt) && o.runs.length === 1 && o.runs[0]?.status === "succeeded" && !!o.reply && ctx.issue()?.conversationState === "waiting"),
    reject: o => o.runs.some(run => ["failed", "timed_out", "cancelled"].includes(run.status)) ? "Canonical guidance run failed" : undefined });
}
export const privilegedObservation = observation;

/** Bind a declared factual operator handoff to its actual persisted human message and native reply. */
export async function companionPhase(ctx: ChatCatalogContext, priorRunIds: string[], message: string) {
  const final = await pollUntil({ label: "Native reply to the actual operator receipt", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
    load: async () => { await ctx.refreshIssue(); return { issue: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: o => chatCatalogNativePhaseIsTimely(ctx) && (o.issue?.conversationState === "waiting" && o.runs.length === priorRunIds.length + 1 && o.runs.every(run => run.status === "succeeded")) });
  const run = final.runs.find(run => !priorRunIds.includes(run.id) && run.agentId === ctx.input.fixtures.agent.id);
  if (!run) throw new Error("Operator receipt did not produce its own native reply");
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
  const human = comments.filter(comment => !comment.authorAgentId && comment.body === message);
  const replies = comments.filter(comment => comment.authorAgentId === ctx.input.fixtures.agent.id && comment.createdByRunId === run.id);
  const profile = await ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`);
  return { humanCommentId: human[0]?.id, runId: run.id, reply: replies.map(row => row.body).join("\n"),
    attributed: human.length === 1 && replies.length > 0 && profile.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id) === true
      && replies.every(reply => Date.parse(reply.createdAt!) >= Date.parse(human[0]!.createdAt!)) };
}
