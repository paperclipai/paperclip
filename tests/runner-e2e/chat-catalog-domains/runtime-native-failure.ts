import { pollUntil } from "../api.js";
import { isDeepStrictEqual } from "node:util";
import { collectRunEvents } from "../run-observations.js";
import type { ChatRun } from "../chat-flow.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { RuntimeAgent } from "./runtime-support.js";
interface NativeFailureRun extends ChatRun {
  nativeIssueId?: string | null;
  runnerProfileJson?: { nativeExecutionInput?: { provider?: { kind?: string; model?: string | null } } };
}
interface NativeEvent { seq?: number; eventType?: string; payload?: { prpEvent?: { eventType?: string } } }
export function admittedModelFailure(input: { run?: NativeFailureRun; events: NativeEvent[]; companyId: string; agentId: string; issueId: string; model: string; provider?: "codex" | "opencode" }) {
  const r = input.run, provider = r?.runnerProfileJson?.nativeExecutionInput?.provider;
  return !!r && r.runtimeMode === "native" && r.status === "failed" && !!r.startedAt && !!r.errorCode && !!r.error
    && r.companyId === input.companyId && r.agentId === input.agentId
    && [r.nativeIssueId, r.contextSnapshot?.issueId, r.contextSnapshot?.taskId].includes(input.issueId)
    && provider?.kind === (input.provider ?? "codex") && provider.model === input.model
    && input.events.some(event => [event.eventType, event.payload?.prpEvent?.eventType].some(type => type === "run.terminal" || type === "turn.failed"));
}
/** A real public configuration/invocation fixture, never a synthetic failure.
 * The caller supplies exactly one ordinary task/routine invocation and retains
 * its own invocation receipt. HTTP/preflight rejection is a setup blocker.
 * This source-qualified recipe is not live qualification until this predicate
 * observes an actually admitted native failed row and durable terminal events.
 */
export async function unavailableNativeModelFailure(ctx: ChatCatalogContext, worker: RuntimeAgent,
  invoke: () => Promise<{ issueId: string }>) {
  const endpoint = `/api/agents/${worker.id}`;
  const original = await ctx.input.api.get<RuntimeAgent>(endpoint);
  if (original.lifecycleState !== "ready" || !["active", "idle"].includes(original.status ?? "")
    || original.adapterType !== "paperclip_runner" || !["codex", "opencode"].includes(String(original.adapterConfig?.provider)))
    throw new Error("Native failure prerequisite requires an actually ready selected native Codex or OpenCode worker");
  const provider = original.adapterConfig!.provider as "codex" | "opencode";
  const before = await ctx.allRuns(); const model = unavailableNativeModel(provider, ctx.input.nonce);
  for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }])
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true,
      isActive: true, unpricedUsagePolicy: "allow" });
  let failed: NativeFailureRun | undefined;
  try {
    const configured = await ctx.input.api.patch<RuntimeAgent>(endpoint, { adapterConfig: { ...original.adapterConfig, model } });
    if (configured.adapterConfig?.model !== model || configured.lifecycleState !== "ready")
      throw new Error("Unavailable-model configuration was not retained on the admitted worker; no failed-native coverage");
    const receipt = await invoke();
    if (!receipt.issueId) throw new Error("Native failure invocation did not return an actual source task");
    const settled = await pollUntil({ label: "Actual admitted unavailable-model native failure", deadlineAt: Date.now() + 150_000,
      load: async () => (await ctx.allRuns()).filter(run => !before.some(prior => prior.id === run.id)),
      accept: rows => rows.length === 1 && rows[0]?.status === "failed",
      reject: rows => rows.length > 1 ? "Failure prerequisite admitted more than its one declared invocation"
        : rows.some(run => ["succeeded", "cancelled", "timed_out"].includes(run.status)) ? "Invocation did not produce genuine native failed history" : undefined });
    failed = await ctx.input.api.get<NativeFailureRun>(`/api/heartbeat-runs/${settled[0]!.id}`);
    const events = await collectRunEvents<NativeEvent>((afterSeq, limit) => ctx.input.api.get(`/api/heartbeat-runs/${failed!.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    if (!admittedModelFailure({ run: failed, events, companyId: ctx.input.fixtures.company.id, agentId: worker.id, issueId: receipt.issueId, model, provider }))
      throw new Error("Actual invocation lacks admitted model-bound native failure evidence; no failure coverage claimed");
    return { failedRun: failed, failedRunEvents: events, failedIssueId: receipt.issueId, failedModel: model,
      failureKind: "native-failure-under-explicit-unavailable-model-configuration", originalConfiguration: original };
  } finally {
    await ctx.input.api.patch(endpoint, { adapterConfig: original.adapterConfig });
    const current = await ctx.input.api.get<RuntimeAgent>(endpoint);
    if (current.status === "error") await ctx.input.api.post(`${endpoint}/clear-error`, {});
    const restored = await ctx.input.api.get<RuntimeAgent>(endpoint);
    if (!isDeepStrictEqual(restored.adapterConfig, original.adapterConfig)) throw new Error("Original admitted model configuration was not restored");
  }
}

/** OpenCode requires a provider-qualified ID; actual admission and persisted failure remain mandatory. */
export function unavailableNativeModel(provider: "codex" | "opencode", nonce: string) {
  const id = `paperclip-eval-unavailable-${nonce}`;
  return provider === "opencode" ? `openrouter/paperclip-eval/${id}` : id;
}
