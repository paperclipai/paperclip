import type { ConnectionFailure } from "@paperclipai/adapter-utils/connection-failure";
import { HttpError } from "../errors.js";
import { classifyRemoteConnectionError, readRemoteConnectionFailure } from "./remote-connection-failure.js";

type McpConnectionFailure = Extract<ConnectionFailure, { provider: "mcp_http" }>;
type Reason = McpConnectionFailure["reason"];

// These are local provenance receipts, never properties supplied by a provider,
// request body, or persisted error. They affect Sentry reporting only.
const failures = new WeakMap<Error, McpConnectionFailure>();

function remember(error: Error, reason: Reason): void {
  failures.set(error, { schemaVersion: 1, provider: "mcp_http", operation: "discover_tools", reason });
}

/** Call only around the outbound MCP request or its response-body read. */
export async function withMcpConnectionFailure<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof Error) {
      const reason = readRemoteConnectionFailure(error) ?? classifyRemoteConnectionError(error);
      if (reason) remember(error, reason);
    }
    throw error;
  }
}

/** Preserve the existing HTTP failure; classify only the actual remote status. */
export function mcpDiscoveryHttpFailure(response: Response, message: string): HttpError {
  const error = new HttpError(502, message, { status: response.status });
  const status = response.status;
  const reason: Reason | null = status === 401 || status === 403 ? "authentication_failed"
    : status === 404 ? "endpoint_not_found"
      : status === 429 ? "rate_limited"
        : status >= 500 && status <= 599 ? "remote_unavailable" : null;
  if (reason) remember(error, reason);
  return error;
}

/** Rewrapping a known error must not classify unrelated persistence failures. */
export function retainMcpConnectionFailure(source: unknown, target: HttpError): HttpError {
  const failure = source instanceof Error ? failures.get(source) : undefined;
  if (failure) failures.set(target, failure);
  else {
    const reason = readRemoteConnectionFailure(source);
    if (reason) remember(target, reason);
  }
  return target;
}

export function isExpectedMcpConnectionFailure(error: unknown): boolean {
  return error instanceof HttpError && error.status === 502 && failures.has(error);
}
