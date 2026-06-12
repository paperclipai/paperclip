export type JsonRpcId = string | number;

export const CLAUDE_BRIDGE_METHOD_INITIALIZE = "initialize";
export const CLAUDE_BRIDGE_METHOD_HEALTH_CHECK = "health/check";
export const CLAUDE_BRIDGE_METHOD_RUN_EXECUTE = "run/execute";

export const CLAUDE_BRIDGE_NOTIFICATION_RUN_LOG = "run/log";
export const CLAUDE_BRIDGE_NOTIFICATION_RUN_SPAWN = "run/spawn";

export interface ClaudeBridgeClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface ClaudeBridgeInitializeParams {
  clientInfo?: ClaudeBridgeClientInfo;
}

export interface ClaudeBridgeServerInfo {
  name: string;
  version: string;
}

export interface ClaudeBridgeInitializeResult {
  serverInfo: ClaudeBridgeServerInfo;
}

export interface ClaudeBridgeHealthCheckResult {
  bridge: string;
  authConfigured: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
}

export interface ClaudeBridgeAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface ClaudeBridgeRuntime {
  sessionId: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  taskKey: string | null;
}

export interface ClaudeBridgeResolvedInstructions {
  sourcePath: string;
  contents: string;
}

export interface ClaudeBridgeRunExecuteParams {
  runId: string;
  agent: ClaudeBridgeAgent;
  runtime: ClaudeBridgeRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string | null;
  resolvedInstructions?: ClaudeBridgeResolvedInstructions | null;
}

export interface ClaudeBridgeRunLogParams {
  runId: string | null;
  stream: "stdout" | "stderr";
  chunk: string;
}

export interface ClaudeBridgeRunSpawnParams {
  runId: string | null;
  pid: number;
  processGroupId: number | null;
  startedAt: string;
}

export interface ClaudeBridgeJsonRpcRequest<TParams = unknown> {
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface ClaudeBridgeJsonRpcNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface ClaudeBridgeJsonRpcResponse<TResult = unknown> {
  id?: JsonRpcId;
  result?: TResult;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
}
