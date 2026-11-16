import type { AiConnectionBinding, AiConnectionList } from "../../../packages/shared/src/ai-connections.js";
import type { ConnectionGrantsResponse, ToolConnectionInstall } from "../../../packages/shared/src/types/tool-access.js";
import { AGENT_STATUSES } from "../../../packages/shared/src/constants.js";
import { AGENT_LIFECYCLE_STATES } from "../../../packages/shared/src/types/agent-lifecycle.js";

export const NEW_COMPANY_NATIVE_MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";
export const NEW_COMPANY_PROVIDER_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export interface NativeCompany { id: string; name: string; issuePrefix: string; defaultResponsibleUserId?: string | null }
export interface NativeFirstAgent {
  id: string; companyId: string; name: string; role: string; adapterType: string;
  adapterConfig: Record<string, unknown>; runtimeConfig: { aiConnection?: AiConnectionBinding; heartbeat?: { enabled?: boolean } };
  defaultEnvironmentId?: string | null; lifecycleState: string; status: string;
}
export interface NativeSetupRequest {
  companyId: string; agentId: string; environmentId: string; adapterType: string; provider: string; model: string; sequence: number;
  binding?: AiConnectionBinding; containsCredential: boolean;
}
export interface NativeSetupProbe extends NativeSetupRequest {
  httpStatus: number; resultAdapterType: string; status: string; checks: Array<{ code: string; level: string }>;
}
export interface NewCompanyNativeReceipt {
  companyId: string; companyPrefix: string; firstAgentId: string; companyName: string; agentName: string;
  requestedHarness: "opencode_local"; actualHarness: "opencode_local"; model: string;
  environmentId: string; environmentDriver: "local"; actualProbeEnvironmentId: string;
  beforeCompanyIds: string[]; afterCompanyIds: string[]; beforeReadyAgents: number; afterAgentIds: string[];
  noAgentBeforeRouteDeparture: true; publicSetupRoute: string; savedSetupAgentId: string;
  hello: NativeSetupProbe; helloCount: number; hiredThroughPublicSetup: true; hireCount: number;
  firstAgentReady: true; chatComposerVisible: true; heartbeatRunIds: string[]; readyConversationPath: string;
  account: { id: string; grantId: string; provider: "openrouter"; method: "api_key"; status: "connected"; ownership: "personal"; ownerUserId: string; currentUserId: string; responsibleUserId: string; bindingMode: "delegated" };
  exactPublicGrantAndAgentInstall: true; draftContainsCredential: boolean; publicAgentContainsCredential: boolean;
  verificationKind: "public-native-hello-probe"; firstWorkExecuted: false; probeUsage: "unavailable-outside-heartbeat-accounting";
}
export function nativeSetupRequest(input: { companyId: string; adapterType: string; body: unknown; sequence: number }, credential: string): NativeSetupRequest {
  const body = input.body as Record<string, unknown>; const config = body?.adapterConfig as Record<string, unknown> | undefined;
  return { companyId: input.companyId, adapterType: input.adapterType, sequence: input.sequence,
    agentId: typeof body?.agentId === "string" ? body.agentId : typeof body?.setupAgentId === "string" ? body.setupAgentId : "",
    environmentId: typeof body?.environmentId === "string" ? body.environmentId : typeof body?.defaultEnvironmentId === "string" ? body.defaultEnvironmentId : "",
    provider: typeof config?.provider === "string" ? config.provider : "", model: typeof config?.model === "string" ? config.model : "",
    binding: (body?.aiConnection ?? (body?.runtimeConfig as { aiConnection?: AiConnectionBinding } | undefined)?.aiConnection) as AiConnectionBinding | undefined,
    containsCredential: Boolean(credential && JSON.stringify(input.body).includes(credential)) };
}
// Step names use hyphens; product enum values may use underscores.
function agentLifecycleReason(state: string) { return `agent-lifecycle-${state.replaceAll("_", "-")}` as `agent-lifecycle-${string}`; }
function agentStatusReason(status: string) { return `agent-status-${status.replaceAll("_", "-")}` as `agent-status-${string}`; }
export const NATIVE_PROOF_FAILURE_REASONS = ["environment", "probe-count", "hire-count",
  "probe-agent", "probe-environment", "probe-model", "probe-credential", "probe-binding", "probe-result", "probe-order",
  "hire-agent", "hire-environment", "hire-model", "hire-credential", "hire-binding", "hire-result",
  "agent-identity", "agent-model", "agent-environment",
  ...[...AGENT_LIFECYCLE_STATES, "unknown"].map(state => agentLifecycleReason(state)),
  ...[...AGENT_STATUSES, "unknown"].map(status => agentStatusReason(status)), "agent-heartbeat", "agent-binding", "responsible-user",
  "account", "account-routing", "grant", "install"] as const;
export type NativeProofFailureReason = typeof NATIVE_PROOF_FAILURE_REASONS[number];
export class NativeProofFailure extends Error {
  constructor(readonly reason: NativeProofFailureReason, message: string) { super(message); }
}
export function requireNativeFirstAgentProof(input: {
  company: NativeCompany; agent: NativeFirstAgent; humanId: string; environment: { id: string; driver: string };
  savedSetupAgentId: string; probes: NativeSetupProbe[]; hires: Array<NativeSetupRequest & { httpStatus: number; resultAgentId: string }>;
  connection: { connectionId: string; grantId: string }; accounts: AiConnectionList;
  grants: ConnectionGrantsResponse; installs: ToolConnectionInstall[];
}): void {
  const { company, agent, humanId, environment, savedSetupAgentId, probes, hires, connection, accounts, grants, installs } = input;
  const binding = agent.runtimeConfig.aiConnection;
  // Each failed check names a fixed reason, so the private child can report
  // which one failed without exposing any value.
  const check = (ok: boolean, reason: NativeProofFailureReason, message: string) => { if (!ok) throw new NativeProofFailure(reason, message); };
  const testAndHire = "New company requires one current same-agent native OpenCode account/model/local-target test and hire";
  const request = (value: NativeSetupRequest, prefix: "probe" | "hire") => {
    check(value.companyId === company.id && value.agentId === savedSetupAgentId, `${prefix}-agent`, testAndHire);
    check(value.environmentId === environment.id, `${prefix}-environment`, testAndHire);
    check(value.adapterType === "paperclip_runner" && value.provider === "opencode" && value.model === NEW_COMPANY_NATIVE_MODEL, `${prefix}-model`, testAndHire);
    check(value.containsCredential === false, `${prefix}-credential`, testAndHire);
    check(value.binding?.provider === "openrouter" && value.binding.method === "api_key" && value.binding.mode === "delegated"
      && value.binding.connectionId === connection.connectionId && value.binding.grantId === connection.grantId, `${prefix}-binding`, testAndHire);
  };
  check(environment.driver === "local" && !!environment.id, "environment", testAndHire);
  check(probes.length === 1, "probe-count", testAndHire);
  check(hires.length === 1, "hire-count", testAndHire);
  const probe = probes[0]!, hire = hires[0]!;
  request(probe, "probe");
  check(probe.httpStatus === 200 && probe.resultAdapterType === "paperclip_runner" && probe.status === "pass"
    && !probe.checks.some(check => check.level === "error") && probe.checks.some(check => check.code === "opencode_hello_probe_passed"), "probe-result", testAndHire);
  check(Number.isInteger(probe.sequence) && probe.sequence >= 1 && Number.isInteger(hire.sequence) && probe.sequence < hire.sequence, "probe-order", testAndHire);
  request(hire, "hire");
  check(hire.httpStatus >= 200 && hire.httpStatus < 300 && hire.resultAgentId === savedSetupAgentId, "hire-result", testAndHire);
  const configuration = "New company public first-agent identity/configuration differs from the tested setup";
  check(agent.id === savedSetupAgentId && agent.companyId === company.id && agent.role === "ceo", "agent-identity", configuration);
  check(agent.adapterType === "paperclip_runner" && agent.adapterConfig.provider === "opencode" && agent.adapterConfig.model === NEW_COMPANY_NATIVE_MODEL, "agent-model", configuration);
  check(agent.defaultEnvironmentId === environment.id, "agent-environment", configuration);
  // The observed state is reported only through the closed product enums.
  const lifecycle = (AGENT_LIFECYCLE_STATES as readonly string[]).includes(agent.lifecycleState) ? agent.lifecycleState : "unknown";
  const status = (AGENT_STATUSES as readonly string[]).includes(agent.status) ? agent.status : "unknown";
  check(agent.lifecycleState === "ready", agentLifecycleReason(lifecycle), configuration);
  check(["idle", "active"].includes(agent.status), agentStatusReason(status), configuration);
  check(agent.runtimeConfig.heartbeat?.enabled === false, "agent-heartbeat", configuration);
  check(binding?.provider === "openrouter" && binding.method === "api_key" && binding.mode === "delegated"
    && binding.connectionId === connection.connectionId && binding.grantId === connection.grantId, "agent-binding", configuration);
  check(company.defaultResponsibleUserId === humanId && accounts.currentUserId === humanId, "responsible-user", configuration);
  const accountMessage = "New company account requires its actual personal grant and exact first-agent public installation";
  const account = accounts.connections.find(row => row.id === connection.connectionId && row.grantId === connection.grantId);
  const grant = grants.grants.find(row => row.id === connection.grantId);
  check(!!account && account.companyId === company.id && account.provider === "openrouter" && account.method === "api_key"
    && account.status === "connected" && account.ownership === "personal" && account.ownerUserId === humanId, "account", accountMessage);
  check(account!.routing?.kind === "openrouter" && account!.routing.protocol === "chat" && account!.routing.auth === "bearer"
    && account!.routing.models.length === 1 && account!.routing.models[0]?.id === NEW_COMPANY_PROVIDER_MODEL, "account-routing", accountMessage);
  check(grants.connection.id === connection.connectionId && grants.currentUserId === humanId && grant?.connectionId === connection.connectionId
    && grant.companyId === company.id && grant.kind === "user" && grant.subjectUserId === humanId && grant.status === "active", "grant", accountMessage);
  check(installs.length === 1 && installs[0]?.companyId === company.id && installs[0]?.connectionId === connection.connectionId
    && installs[0]?.targetType === "agent" && installs[0]?.targetId === agent.id, "install", accountMessage);
}
