import type { AiConnectionBinding, AiConnectionList } from "../../../packages/shared/src/ai-connections.js";
import type { ConnectionGrantsResponse, ToolConnectionInstall } from "../../../packages/shared/src/types/tool-access.js";

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
export function requireNativeFirstAgentProof(input: {
  company: NativeCompany; agent: NativeFirstAgent; humanId: string; environment: { id: string; driver: string };
  savedSetupAgentId: string; probes: NativeSetupProbe[]; hires: Array<NativeSetupRequest & { httpStatus: number; resultAgentId: string }>;
  connection: { connectionId: string; grantId: string }; accounts: AiConnectionList;
  grants: ConnectionGrantsResponse; installs: ToolConnectionInstall[];
}): void {
  const { company, agent, humanId, environment, savedSetupAgentId, probes, hires, connection, accounts, grants, installs } = input;
  const binding = agent.runtimeConfig.aiConnection;
  const matches = (request: NativeSetupRequest) => request.companyId === company.id && request.agentId === savedSetupAgentId
    && request.environmentId === environment.id && request.adapterType === "paperclip_runner" && request.provider === "opencode"
    && request.model === NEW_COMPANY_NATIVE_MODEL && request.containsCredential === false
    && request.binding?.provider === "openrouter" && request.binding.method === "api_key" && request.binding.mode === "delegated"
    && request.binding.connectionId === connection.connectionId && request.binding.grantId === connection.grantId;
  if (environment.driver !== "local" || !environment.id || probes.length !== 1 || hires.length !== 1
    || !matches(probes[0]!) || probes[0]!.httpStatus !== 200 || probes[0]!.resultAdapterType !== "paperclip_runner" || probes[0]!.status !== "pass"
    || probes[0]!.checks.some(check => check.level === "error") || !probes[0]!.checks.some(check => check.code === "opencode_hello_probe_passed")
    || !Number.isInteger(probes[0]!.sequence) || probes[0]!.sequence < 1 || !Number.isInteger(hires[0]!.sequence) || probes[0]!.sequence >= hires[0]!.sequence
    || !matches(hires[0]!) || hires[0]!.httpStatus < 200 || hires[0]!.httpStatus >= 300 || hires[0]!.resultAgentId !== savedSetupAgentId)
    throw new Error("New company requires one current same-agent native OpenCode account/model/local-target test and hire");
  if (agent.id !== savedSetupAgentId || agent.companyId !== company.id || agent.role !== "ceo" || agent.adapterType !== "paperclip_runner"
    || agent.adapterConfig.provider !== "opencode" || agent.adapterConfig.model !== NEW_COMPANY_NATIVE_MODEL
    || agent.defaultEnvironmentId !== environment.id || agent.lifecycleState !== "ready" || !["idle", "active"].includes(agent.status)
    || agent.runtimeConfig.heartbeat?.enabled !== false
    || binding?.provider !== "openrouter" || binding.method !== "api_key" || binding.mode !== "delegated"
    || binding.connectionId !== connection.connectionId || binding.grantId !== connection.grantId
    || company.defaultResponsibleUserId !== humanId || accounts.currentUserId !== humanId)
    throw new Error("New company public first-agent identity/configuration differs from the tested setup");
  const account = accounts.connections.find(row => row.id === connection.connectionId && row.grantId === connection.grantId);
  const grant = grants.grants.find(row => row.id === connection.grantId);
  if (!account || account.companyId !== company.id || account.provider !== "openrouter" || account.method !== "api_key"
    || account.status !== "connected" || account.ownership !== "personal" || account.ownerUserId !== humanId
    || account.routing?.kind !== "openrouter" || account.routing.protocol !== "chat" || account.routing.auth !== "bearer"
    || account.routing.models.length !== 1 || account.routing.models[0]?.id !== NEW_COMPANY_PROVIDER_MODEL
    || grants.connection.id !== connection.connectionId || grants.currentUserId !== humanId || grant?.connectionId !== connection.connectionId
    || grant.companyId !== company.id || grant.kind !== "user" || grant.subjectUserId !== humanId || grant.status !== "active"
    || installs.length !== 1 || installs[0]?.companyId !== company.id || installs[0]?.connectionId !== connection.connectionId
    || installs[0]?.targetType !== "agent" || installs[0]?.targetId !== agent.id)
    throw new Error("New company account requires its actual personal grant and exact first-agent public installation");
}
