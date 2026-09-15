import { randomUUID } from "node:crypto";
import type { toolConnections } from "@paperclipai/db";

type HeaderSession = {
  id: string;
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  runId: string | null;
};

type CallerHeaders = Record<string, string | string[] | undefined>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
type HeaderPolicyConfig = {
  staticHeaders: Array<{ name: string; value: string }>;
  passthroughAllowlist: string[];
  metadataHeaders: Array<
    | "company_id"
    | "agent_id"
    | "issue_id"
    | "project_id"
    | "run_id"
    | "gateway_session_id"
    | "correlation_id"
  >;
};

export type HeaderPolicySummary = {
  staticHeaderNames: string[];
  credentialHeaderNames: string[];
  passthroughHeaderNames: string[];
  droppedPassthroughHeaderNames: string[];
  metadataHeaderNames: string[];
  collisionRules: Array<{ header: string; source: string; action: string }>;
};
const sensitivePassthroughHeaderPattern =
  /(^|[-_])(auth|authorization|cookie|secret|session|token)([-_]|$)|(^|[-_])api[-_]?key([-_]|$)/i;
const sensitivePassthroughHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-paperclip-tool-gateway-token",
]);

function isSensitivePassthroughHeader(name: string) {
  return (
    name.startsWith("x-paperclip-") ||
    sensitivePassthroughHeaderNames.has(name) ||
    sensitivePassthroughHeaderPattern.test(name)
  );
}
function headerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function headerValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/[\r\n]/.test(value)) return null;
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readHeaderPolicy(
  connection: typeof toolConnections.$inferSelect,
): HeaderPolicyConfig {
  const config = asRecord(connection.config) ?? {};
  const transportConfig = asRecord(connection.transportConfig) ?? {};
  const rawPolicy =
    asRecord(config.headerPolicy) ??
    asRecord(transportConfig.headerPolicy) ??
    {};
  const passthrough = asRecord(rawPolicy.passthrough) ?? {};
  const staticHeaders = rawPolicy.staticHeaders;
  const parsedStaticHeaders: Array<{ name: string; value: string }> = [];

  if (Array.isArray(staticHeaders)) {
    for (const entry of staticHeaders) {
      const record = asRecord(entry);
      const name = headerName(record?.name);
      const value = headerValue(record?.value);
      if (name && value !== null) parsedStaticHeaders.push({ name, value });
    }
  } else {
    const record = asRecord(staticHeaders);
    if (record) {
      for (const [rawName, rawValue] of Object.entries(record)) {
        const name = headerName(rawName);
        const value = headerValue(rawValue);
        if (name && value !== null) parsedStaticHeaders.push({ name, value });
      }
    }
  }

  const passthroughAllowlist = [
    ...stringArray(passthrough.allow),
    ...stringArray(passthrough.allowedHeaders),
    ...stringArray(rawPolicy.allowedPassthroughHeaders),
  ]
    .map(headerName)
    .filter((name): name is string => Boolean(name))
    .filter((name) => !isSensitivePassthroughHeader(name));

  const metadata = asRecord(rawPolicy.metadata) ?? {};
  const metadataHeaders = [
    ...stringArray(metadata.forward),
    ...stringArray(metadata.headers),
    ...stringArray(rawPolicy.forwardContextHeaders),
  ].filter(
    (value): value is HeaderPolicyConfig["metadataHeaders"][number] =>
      value === "company_id" ||
      value === "agent_id" ||
      value === "issue_id" ||
      value === "project_id" ||
      value === "run_id" ||
      value === "gateway_session_id" ||
      value === "correlation_id",
  );

  return {
    staticHeaders: parsedStaticHeaders,
    passthroughAllowlist: [...new Set(passthroughAllowlist)],
    metadataHeaders: [...new Set(metadataHeaders)],
  };
}
function normalizeCallerHeaders(
  input: CallerHeaders | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input ?? {})) {
    const name = headerName(rawName);
    if (!name) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
    const normalizedValue = headerValue(value);
    if (normalizedValue !== null) headers[name] = normalizedValue;
  }
  return headers;
}

function metadataHeadersForSession(
  session: HeaderSession | undefined,
  policy: HeaderPolicyConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!session) return headers;
  const values: Record<
    HeaderPolicyConfig["metadataHeaders"][number],
    string | null
  > = {
    company_id: session.companyId,
    agent_id: session.agentId,
    issue_id: session.issueId,
    project_id: session.projectId,
    run_id: session.runId,
    gateway_session_id: session.id,
    correlation_id: randomUUID(),
  };
  for (const key of policy.metadataHeaders) {
    const value = values[key];
    if (value) headers[`x-paperclip-${key.replace(/_/g, "-")}`] = value;
  }
  return headers;
}

export function buildRemoteHeaders(input: {
  session?: HeaderSession;
  connection: typeof toolConnections.$inferSelect;
  projectedHeaders: Record<string, string>;
  credentialHeaders: Record<string, string>;
  callerHeaders?: CallerHeaders;
}): { headers: Record<string, string>; summary: HeaderPolicySummary } {
  const policy = readHeaderPolicy(input.connection);
  const caller = normalizeCallerHeaders(input.callerHeaders);
  const credentialHeaders: Record<string, string> = {};
  // Normalize each layer before merging: credentials override reviewed method
  // headers even when the two sources use different casing for the same name.
  for (const source of [input.projectedHeaders, input.credentialHeaders]) {
    for (const [name, value] of Object.entries(source)) {
      const normalized = headerName(name);
      if (normalized) credentialHeaders[normalized] = value;
    }
  }
  const reservedHeaders = new Set([
    "accept",
    "content-type",
    "content-length",
    "host",
    "connection",
  ]);
  const managedCredentialHeaders = new Set(Object.keys(credentialHeaders));
  const headers: Record<string, string> = {};
  const summary: HeaderPolicySummary = {
    staticHeaderNames: [],
    credentialHeaderNames: Object.keys(credentialHeaders).sort(),
    passthroughHeaderNames: [],
    droppedPassthroughHeaderNames: [],
    metadataHeaderNames: [],
    collisionRules: [],
  };

  for (const [name, value] of Object.entries(caller)) {
    if (reservedHeaders.has(name)) {
      summary.droppedPassthroughHeaderNames.push(name);
      summary.collisionRules.push({
        header: name,
        source: "caller",
        action: "dropped_reserved_header",
      });
      continue;
    }
    if (managedCredentialHeaders.has(name)) {
      summary.droppedPassthroughHeaderNames.push(name);
      summary.collisionRules.push({
        header: name,
        source: "caller",
        action: "kept_managed_credential",
      });
      continue;
    }
    if (isSensitivePassthroughHeader(name)) {
      summary.droppedPassthroughHeaderNames.push(name);
      summary.collisionRules.push({
        header: name,
        source: "caller",
        action: "dropped_sensitive_header",
      });
      continue;
    }
    if (!policy.passthroughAllowlist.includes(name)) {
      summary.droppedPassthroughHeaderNames.push(name);
      continue;
    }
    headers[name] = value;
    summary.passthroughHeaderNames.push(name);
  }

  for (const { name, value } of policy.staticHeaders) {
    if (reservedHeaders.has(name)) {
      summary.collisionRules.push({
        header: name,
        source: "static",
        action: "dropped_reserved_header",
      });
      continue;
    }
    if (managedCredentialHeaders.has(name)) {
      summary.collisionRules.push({
        header: name,
        source: "static",
        action: "kept_managed_credential",
      });
      continue;
    }
    if (headers[name] !== undefined) {
      summary.collisionRules.push({
        header: name,
        source: "static",
        action: "overrode_passthrough",
      });
    }
    headers[name] = value;
    summary.staticHeaderNames.push(name);
  }

  const metadataHeaders = metadataHeadersForSession(input.session, policy);
  for (const [name, value] of Object.entries(metadataHeaders)) {
    if (reservedHeaders.has(name)) continue;
    if (managedCredentialHeaders.has(name)) {
      summary.collisionRules.push({
        header: name,
        source: "metadata",
        action: "kept_managed_credential",
      });
      continue;
    }
    if (headers[name] !== undefined) {
      summary.collisionRules.push({
        header: name,
        source: "metadata",
        action: "overrode_previous_header",
      });
    }
    headers[name] = value;
    summary.metadataHeaderNames.push(name);
  }

  for (const [name, value] of Object.entries(credentialHeaders)) {
    if (headers[name] !== undefined) {
      summary.collisionRules.push({
        header: name,
        source: "credential",
        action: "overrode_previous_header",
      });
    }
    headers[name] = value;
  }

  summary.staticHeaderNames.sort();
  summary.passthroughHeaderNames.sort();
  summary.droppedPassthroughHeaderNames = [
    ...new Set(summary.droppedPassthroughHeaderNames),
  ].sort();
  summary.metadataHeaderNames.sort();
  return { headers, summary };
}
