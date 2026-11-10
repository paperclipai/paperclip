import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import type { Environment } from "../../../packages/shared/src/types/environment.js";
import type { AiConnectionList } from "../../../packages/shared/src/ai-connections.js";
import { waitForReply } from "./identity-support.js";
import { checks } from "./internal-support.js";
import { collectRunEvents } from "../run-observations.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
import { selectedRuntimeInputs, runtimePrivateSpec } from "./runtime-private.js";
import { privateClaudeOperation, matchesClaudeFixtureTarget } from "./runtime-claude-private.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const operation = "POST /api/companies/{companyId}/adapters/{type}/test-environment";
export function actualAuthenticationFailure(codes: readonly string[]) { return codes.some(code => /(?:auth_required|auth_missing|authentication_failed|login_required|credentials_invalid|invalid_credentials)/i.test(code)); }
/** Correlated trusted native API execution, not an assistant-authored JSON claim. */
export function savedValidationReceipts(events: Array<{ seq?: number; eventType?: string; payload?: unknown }>, expected: { companyId: string; worker: Pick<Agent, "id" | "adapterType" | "adapterConfig" | "defaultEnvironmentId" | "runtimeConfig"> }) {
  const inputs = new Map<string, Record<string, unknown>>(), results = new Map<string, Record<string, unknown>>(), completed = new Set<string>();
  for (const event of events) {
    const payload = record(record(record(event.payload).prpEvent).payload), item = record(payload.item);
    if (event.eventType === "item.started" && item.type === "tool_use" && item.name === "call_api" && typeof item.id === "string") inputs.set(item.id, record(item.input));
    if (event.eventType === "item.completed" && item.type === "tool_result" && typeof item.id === "string" && (!item.tool_use_id || item.tool_use_id === item.id)) results.set(item.id, record(item.result));
    if (event.eventType === "tool.execution.completed" && payload.name === "call_api" && payload.status === "completed" && typeof payload.executionId === "string") completed.add(payload.executionId);
  }
  return [...inputs].flatMap(([id, input]) => {
    if (input.operationId !== operation) return [];
    const result = results.get(id), body = record(input.body), path = record(input.pathParams), data = record(result?.data), codes = Array.isArray(data.checks) ? data.checks.map(row => record(row).code).filter((value): value is string => typeof value === "string") : [];
    return [{ executionId: id, sameConfiguration: path.companyId === expected.companyId && path.type === expected.worker.adapterType && body.agentId === expected.worker.id
      && (body.environmentId === undefined || body.environmentId === expected.worker.defaultEnvironmentId)
      && isDeepStrictEqual(body.adapterConfig, expected.worker.adapterConfig) && isDeepStrictEqual(body.aiConnection, expected.worker.runtimeConfig.aiConnection),
      authenticatedFailure: completed.has(id) && result?.ok === true && result.status === 200 && result.apiOperationId === operation && actualAuthenticationFailure(codes), checkCodes: codes }];
  });
}
export function validationFailureReplyMatches(reply: string) {
  return /authenticat|login|sign.?in|credential|account access/i.test(reply) && /fail|could not|couldn't|unable|not (?:yet )?(?:ready|working)|blocked|needs|requires/i.test(reply)
    && /reconnect|sign.?in|reauthori[sz]|repair|refresh.*(?:account|credential)|check.*(?:account|credential)|human|operator|settings/i.test(reply)
    && !/(?:Morgan|profile|agent)\s+(?:is\s+)?(?:now\s+|fully\s+)?ready\b(?!\s+(?:once|when|after|pending|only|subject)\b)|validation (?:passed|succeeded)|(?:switched|replaced).*(?:account|harness)/i.test(reply);
}
export function gradeClaudeValidation(value: unknown) {
  const c = checks(), o = runtimeObservation(value); c.add("actual-authentication-failure-context", !!o, "A genuinely eligible account and independently observed saved-target authentication failure are required."); if (!o) return c.result();
  const s = o.state, worker = s.worker as Agent, saved = o.agents.find(row => row.id === worker?.id), receipts = s.canonicalValidationReceipts as ReturnType<typeof savedValidationReceipts> | undefined;
  c.add("genuine-target-auth-failure-not-simulated", s.actualAccountEligible === true && s.actualSavedAuthenticationFailure === true && Array.isArray(receipts) && receipts.length === 1 && receipts[0]!.sameConfiguration && receipts[0]!.authenticatedFailure,
    "The actual canonical run completes exactly one allowed saved-configuration API validation and receives real authentication failure; an initially passing target is an unavailable context, never a manufactured provider response.");
  c.add("specific-failure-and-repair-no-false-ready", validationFailureReplyMatches(o.reply), "Chat identifies authentication failure with an actionable human repair path and distinguishes the saved profile from working execution.");
  c.add("no-account-harness-target-substitution-or-paid-work", !!saved && saved.adapterType === worker.adapterType && JSON.stringify(saved.adapterConfig) === JSON.stringify(worker.adapterConfig)
    && JSON.stringify(saved.runtimeConfig?.aiConnection) === JSON.stringify(worker.runtimeConfig.aiConnection) && saved.defaultEnvironmentId === worker.defaultEnvironmentId && s.sameAccountSet === true
    && o.tasks.length === 0 && o.runs.length === 1 && o.runs[0]?.agentId === o.leadId && o.runs[0].status === "succeeded" && o.humanQueries.length === 1,
    "Validation neither switches identity/account/computer nor repeatedly admits employee work or extra human directions.");
  return c.result();
}
export const runtimeClaudeValidationCases = [runtimeDefinition("runs-adapters.validate-hire", async ctx => {
  const selected = selectedRuntimeInputs(ctx, "runs-adapters.validate-hire"), companyId = ctx.input.fixtures.company.id, environmentId = ctx.input.fixtures.environment.id;
  if (selected.values.targetRef !== "fixture.environment" || selected.values.accountBindingRef !== "selected.ANTHROPIC_API_KEY" || !ctx.input.privateSecrets) throw new Error("Setup blocker: require the actual owned selected Claude target/account and private sink");
  const [company, detail, listed] = await Promise.all([ctx.input.api.get<{ id: string }>(`/api/companies/${companyId}`), ctx.input.api.get<Environment>(`/api/environments/${environmentId}`), ctx.input.api.get<Environment[]>(`/api/companies/${companyId}/environments`)]);
  if (!matchesClaudeFixtureTarget({ company, expectedCompanyId: companyId, fixtureEnvironmentId: environmentId, detail, listed })) throw new Error("Selected validation target is not the owned active fixture");
  const credential = selected.credentials.ANTHROPIC_API_KEY!; ctx.input.privateSecrets.push(credential);
  const account = await privateClaudeOperation({ operation: "prepare-account", companyId, environmentId, credential, harnessExecutable: selected.values.harnessExecutable, model: selected.values.model, baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) });
  const accounts = await ctx.input.api.get<AiConnectionList>(`/api/companies/${companyId}/ai-connections`), connection = accounts.connections.find(row => row.id === account.connectionId && row.grantId === account.grantId);
  if (!connection || connection.status !== "connected" || connection.provider !== "anthropic") throw new Error("Actual saved Anthropic account must be eligible before target failure qualification");
  const worker = await ctx.input.api.post<Agent>(`/api/companies/${companyId}/agents`, { name: "Morgan", role: "engineer", title: "Frontend engineer", reportsTo: ctx.input.fixtures.agent.id, adapterType: "claude_local", runner: "legacy", adapterConfig: { command: selected.values.harnessExecutable, model: selected.values.model }, defaultEnvironmentId: environmentId,
    runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 1 }, aiConnection: { provider: "anthropic", method: "api_key", mode: "delegated", connectionId: account.connectionId, grantId: account.grantId } } });
  const saved = await ctx.input.api.get<Agent>(`/api/agents/${worker.id}`), failure = await privateClaudeOperation({ operation: "validate-saved", companyId, environmentId, agentId: worker.id, connectionId: account.connectionId!, grantId: account.grantId!, baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL) }, credential);
  if (!actualAuthenticationFailure(failure.probeCheckCodes)) throw new Error("Context prerequisite unavailable: this actual eligible-account saved target did not return a genuine authentication failure. A qualified stale/expired target session is required; no provider response or credential failure was manufactured.");
  return { worker: saved, actualAccountEligible: true, actualSavedAuthenticationFailure: true, qualificationReceipt: failure, accountIdentities: accounts.connections.map(row => ({ id: row.id, grantId: row.grantId, provider: row.provider, status: row.status })),
    providerProbes: [{ phase: "setup-account", operation: account.operation, publicProbeCount: 2, status: account.probeStatus, usage: "unavailable", cost: "unavailable" }, { phase: "saved-auth-failure-prerequisite", operation: failure.operation, publicProbeCount: 1, status: failure.probeStatus, checkCodes: failure.probeCheckCodes, usage: "unavailable", cost: "unavailable" }] };
}, gradeClaudeValidation, {
  ...runtimePrivateSpec("runs-adapters.validate-hire"), authentication: "human-session", expectedRunCount: 1, attemptTimeoutMs: 600000,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["saved-eligible-account-with-genuine-auth-failure"] },
  async verifySetup(ctx, s) {
    const worker = s.worker as Agent, actual = await ctx.input.api.get<Agent>(`/api/agents/${worker.id}`), accounts = await ctx.input.api.get<AiConnectionList>(`/api/companies/${ctx.input.fixtures.company.id}/ai-connections`);
    const lead = await ctx.input.api.get<Agent>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const receipt = s.qualificationReceipt as { agentId?: string; environmentId?: string; probeCheckCodes?: string[] }, binding = actual.runtimeConfig.aiConnection;
    const c = checks(); c.add("saved-eligible-account-with-genuine-auth-failure", lead.lifecycleState === "ready" && actual.companyId === ctx.input.fixtures.company.id && isDeepStrictEqual(actual.adapterConfig, worker.adapterConfig) && isDeepStrictEqual(actual.runtimeConfig.aiConnection, worker.runtimeConfig.aiConnection)
      && receipt.agentId === actual.id && receipt.environmentId === actual.defaultEnvironmentId && actualAuthenticationFailure(receipt.probeCheckCodes ?? []) && binding?.mode === "delegated" && accounts.connections.some(row => row.id === binding.connectionId && row.grantId === binding.grantId && row.status === "connected" && row.provider === "anthropic"),
      "The independently fetched exact saved configuration/account matches the actual isolated target authentication-failure receipt; no artificial ready employee status is needed."); return c.result();
  },
  sourceFiles: ["chat-catalog-domains/runtime-claude-validation.ts", "chat-catalog-domains/runtime-claude-private.ts", "chat-catalog-domains/runtime-claude-private-worker.ts", "chat-catalog-domains/runtime-private.ts", "chat-catalog-domains/runtime-support.ts", "run-observations.ts", "../../server/src/routes/agents.ts", "../../server/src/services/ai-connection-runtime.ts", "chat-scenarios/runs-adapters.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx); const runs = await ctx.allRuns(), worker = state.worker as Agent;
    const events = await collectRunEvents<{ seq?: number; eventType?: string; payload?: unknown }>((afterSeq, limit) => ctx.input.api.get(`/api/heartbeat-runs/${runs[0]!.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    for (const event of events) {
      const item = record(record(record(record(event.payload).prpEvent).payload).item), result = record(item.result), artifact = record(result.artifact);
      if (event.eventType !== "item.completed" || item.type !== "tool_result" || result.apiOperationId !== operation || result.data !== undefined || typeof artifact.artifactId !== "string" || !/^[a-f0-9-]{36}$/i.test(artifact.artifactId)) continue;
      const response = await ctx.input.api.request.get(`/api/assets/${artifact.artifactId}/content`);
      if (!response.ok()) throw new Error("Actual validation response artifact could not be independently read");
      const bytes = await response.body(); await response.dispose();
      if (bytes.length > 1048576 || bytes.length !== artifact.byteSize || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Validation response artifact bytes/hash disagree with the actual native tool receipt");
      try { result.data = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Actual validation response artifact was not complete JSON"); }
    }
    const receipts = savedValidationReceipts(events, { companyId: ctx.input.fixtures.company.id, worker }); state.canonicalValidationReceipts = receipts;
    (state.providerProbes as unknown[]).push({ phase: "canonical-native-validation", operation: "test-environment", publicProbeCount: receipts.length, status: receipts.length === 1 && receipts[0]?.authenticatedFailure ? "authentication-failure" : "unproven", usage: "unavailable", cost: "unavailable" });
  },
  async observe(ctx, state) { const o = await observeRuntime(ctx, state), accounts = await ctx.input.api.get<AiConnectionList>(`/api/companies/${o.companyId}/ai-connections`); state.sameAccountSet = JSON.stringify(accounts.connections.map(row => ({ id: row.id, grantId: row.grantId, provider: row.provider, status: row.status }))) === JSON.stringify(state.accountIdentities); return o; },
})];
