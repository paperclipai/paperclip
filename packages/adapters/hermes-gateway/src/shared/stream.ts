export type HermesGatewayClientHello = {
  type: "hello";
  protocolVersion: 1;
  client: {
    name: string;
    version: string;
  };
};

export type HermesGatewayWakeRun = {
  type: "wake.run";
  requestId: string;
  idempotencyKey: string;
  session: {
    key: string;
    strategy: "fixed" | "issue" | "run";
  };
  paperclip: {
    apiUrl: string;
    authToken: string;
  };
  agent: {
    id: string;
    companyId: string;
    name: string;
    role: string;
  };
  context: {
    runId: string;
    issueId: string | null;
    taskId: string | null;
    wakeReason: string | null;
    actionHint?: string;
    followupIssue?: Record<string, unknown>;
    issueIds: string[];
    governance?: Record<string, unknown>;
  };
  prompt: {
    system: string;
    user?: string;
  };
  runtime: {
    model?: string;
    toolsets?: string[];
    maxTurns?: number | null;
  };
};

export type HermesGatewayServerAck = {
  type: "ack";
  requestId: string;
  accepted: boolean;
  session?: {
    id: string;
    resumed: boolean;
  };
};

export type HermesGatewayServerLog = {
  type: "event.log";
  requestId: string;
  stream: "stdout" | "stderr";
  text: string;
};

export type HermesGatewayServerState = {
  type: "event.state";
  requestId: string;
  state: "queued" | "running" | "waiting_on_tool" | "waiting_on_paperclip" | "completed" | "failed";
};

export type HermesGatewayServerFinal = {
  type: "final";
  requestId: string;
  ok: boolean;
  summary: string;
  errorCode?: string;
  session?: {
    id: string;
    resumed: boolean;
  };
  usage?: Record<string, number>;
};

export type HermesGatewayServerFrame =
  | HermesGatewayServerAck
  | HermesGatewayServerLog
  | HermesGatewayServerState
  | HermesGatewayServerFinal;
