#!/usr/bin/env node
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, JSONRPCRequest, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { isJSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createPaperclipMcpServer } from "./index.js";

const CALL_TOOL_METHOD = "tools/call";
const CALLER_ID_HEADER_NAMES = ["x-paperclip-caller-id", "x-paperclip-caller", "x-occ-mcp-caller"];
const CALLER_ENV_HEADER_NAMES = ["x-paperclip-caller-env", "x-occ-mcp-caller-env"];
const CALLER_ID_ALLOWLIST_ENV_NAMES = [
  "PAPERCLIP_MCP_CALLER_ID_ALLOWLIST",
  "PAPERCLIP_MCP_ALLOWED_CALLERS",
  "PAPERCLIP_ALLOWED_CALLERS",
];
const EXPECTED_CALLER_ENV_ENV_NAMES = [
  "PAPERCLIP_MCP_CALLER_ENV",
  "PAPERCLIP_EXPECTED_CALLER_ENV",
];

export interface CallerGuardConfig {
  enabled: boolean;
  allowedCallerIds: Set<string>;
  expectedCallerEnv: string | null;
}

export interface CallerHeaders {
  callerId: string | null;
  callerEnv: string | null;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstNonEmptyEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  for (const name of names) {
    const value = nonEmptyString(env[name]);
    if (value) return value;
  }
  return null;
}

function parseCsvEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  const raw = firstNonEmptyEnv(env, names);
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getMetaRecord(request: JSONRPCRequest): Record<string, unknown> {
  return isRecord(request.params) && isRecord(request.params._meta) ? request.params._meta : {};
}

function normalizeHeaderRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim().toLowerCase();
    const stringValue = nonEmptyString(rawValue);
    if (key && stringValue) {
      headers[key] = stringValue;
    }
  }
  return headers;
}

function readHeader(headers: Record<string, string>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = nonEmptyString(headers[name]);
    if (value) return value;
  }
  return null;
}

export function readCallerGuardConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CallerGuardConfig {
  const allowedCallerIds = new Set(
    parseCsvEnv(env, CALLER_ID_ALLOWLIST_ENV_NAMES).map((value) => normalizeToken(value)),
  );
  const expectedCallerEnv = firstNonEmptyEnv(env, EXPECTED_CALLER_ENV_ENV_NAMES);

  return {
    enabled: allowedCallerIds.size > 0 || expectedCallerEnv !== null,
    allowedCallerIds,
    expectedCallerEnv: expectedCallerEnv ? normalizeToken(expectedCallerEnv) : null,
  };
}

export function extractCallerHeaders(request: JSONRPCRequest): CallerHeaders {
  const meta = getMetaRecord(request);
  const requestInfo = isRecord(meta.requestInfo) ? meta.requestInfo : null;
  const headers = normalizeHeaderRecord(meta.headers ?? requestInfo?.headers);

  return {
    callerId: readHeader(headers, CALLER_ID_HEADER_NAMES),
    callerEnv: readHeader(headers, CALLER_ENV_HEADER_NAMES),
  };
}

export function validateCallerGuard(request: JSONRPCRequest, config: CallerGuardConfig): string | null {
  if (!config.enabled || request.method !== CALL_TOOL_METHOD) {
    return null;
  }

  const { callerId, callerEnv } = extractCallerHeaders(request);
  if (config.allowedCallerIds.size > 0) {
    const normalizedCallerId = callerId ? normalizeToken(callerId) : null;
    if (!normalizedCallerId) {
      return "Forbidden: missing caller id header";
    }
    if (!config.allowedCallerIds.has(normalizedCallerId)) {
      return `Forbidden: caller "${callerId}" is not allowed`;
    }
  }

  if (config.expectedCallerEnv) {
    const normalizedCallerEnv = callerEnv ? normalizeToken(callerEnv) : null;
    if (!normalizedCallerEnv) {
      return "Forbidden: missing caller env header";
    }
    if (normalizedCallerEnv !== config.expectedCallerEnv) {
      return `Forbidden: caller environment "${callerEnv}" does not match expected "${config.expectedCallerEnv}"`;
    }
  }

  return null;
}

function createForbiddenResponse(request: JSONRPCRequest, message: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id: request.id,
    error: {
      code: 403,
      message,
    },
  };
}

export class CallerGuardingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: Transport,
    private readonly config: CallerGuardConfig,
  ) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  get setProtocolVersion(): Transport["setProtocolVersion"] {
    return this.inner.setProtocolVersion;
  }

  async start(): Promise<void> {
    this.inner.onclose = () => {
      this.onclose?.();
    };
    this.inner.onerror = (error) => {
      this.onerror?.(error);
    };
    this.inner.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message)) {
        const rejection = validateCallerGuard(message, this.config);
        if (rejection) {
          void this.inner.send(createForbiddenResponse(message, rejection)).catch((error) => {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          });
          return;
        }
      }
      this.onmessage?.(message, extra);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export function createStdioServerTransport(env: NodeJS.ProcessEnv = process.env): Transport {
  return new CallerGuardingTransport(
    new StdioServerTransport(process.stdin, process.stdout),
    readCallerGuardConfigFromEnv(env),
  );
}

export async function runStdioServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  await server.connect(createStdioServerTransport());
}

void runStdioServer().catch((error) => {
  console.error("Failed to start Paperclip MCP server:", error);
  process.exit(1);
});