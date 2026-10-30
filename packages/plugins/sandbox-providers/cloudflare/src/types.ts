export interface CloudflareDriverConfig {
  bridgeBaseUrl: string;
  bridgeAuthToken: string;
  reuseLease: boolean;
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
  requestedCwd: string;
  sessionStrategy: "named" | "default";
  sessionId: string;
  timeoutMs: number;
  bridgeRequestTimeoutMs: number;
  previewHostname: string | null;
}

export interface CloudflareBridgeHealthResponse {
  ok: boolean;
  provider: "cloudflare";
  bridgeVersion: string;
  capabilities: {
    reuseLease: boolean;
    namedSessions: boolean;
    previewUrls: boolean;
  };
}

export interface CloudflareBridgeProbeRequest {
  requestedCwd: string;
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
  sessionStrategy: CloudflareDriverConfig["sessionStrategy"];
  sessionId: string;
  timeoutMs: number;
}

export interface CloudflareBridgeProbeResponse {
  ok: boolean;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface CloudflareBridgeAcquireLeaseRequest {
  environmentId: string;
  runId: string;
  issueId?: string | null;
  reuseLease: boolean;
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
  requestedCwd: string;
  sessionStrategy: CloudflareDriverConfig["sessionStrategy"];
  sessionId: string;
  timeoutMs: number;
}

export interface CloudflareBridgeResumeLeaseRequest {
  providerLeaseId: string;
  requestedCwd: string;
  sessionStrategy: CloudflareDriverConfig["sessionStrategy"];
  sessionId: string;
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
  timeoutMs: number;
}

export interface CloudflareBridgeReleaseLeaseRequest {
  providerLeaseId: string;
  reuseLease: boolean;
  keepAlive: boolean;
}

export interface CloudflareBridgeLeaseResponse {
  providerLeaseId: string;
  metadata?: Record<string, unknown>;
}

export interface CloudflareBridgeExecuteRequest {
  providerLeaseId: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  streamOutput?: boolean;
  sessionStrategy: CloudflareDriverConfig["sessionStrategy"];
  sessionId: string;
}

export interface CloudflareBridgeExecuteResponse {
  exitCode: number | null;
  signal?: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  metadata?: Record<string, unknown>;
}
