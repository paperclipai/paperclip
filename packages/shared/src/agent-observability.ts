import { z } from "zod";

export const DEFAULT_AGENT_OBSERVABILITY_CAPTURE = {
  userPrompts: true,
  assistantResponses: true,
  toolDetails: true,
  toolContent: true,
} as const;

export const agentObservabilityCaptureSchema = z.strictObject({
  userPrompts: z.boolean(), assistantResponses: z.boolean(),
  toolDetails: z.boolean(), toolContent: z.boolean(),
});
export type AgentObservabilityCapture = z.infer<typeof agentObservabilityCaptureSchema>;

export function normalizeOtlpBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS base URL without credentials, query, or fragment.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (/\/v1\/(?:logs|traces|metrics)$/i.test(url.pathname)) {
    throw new Error("Enter the OTLP base URL, without /v1/logs or /v1/traces.");
  }
  return url.toString().replace(/\/+$/, "");
}

const baseUrl = z.string().max(2048).transform((value, ctx) => {
  try { return normalizeOtlpBaseUrl(value); }
  catch { ctx.addIssue({ code: "custom", message: "Enter an HTTP or HTTPS OTLP base URL without credentials, query, fragment, or signal path." }); return z.NEVER; }
});
export const agentObservabilityDestinationSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("braintrust"), projectId: z.string().uuid() }),
  z.strictObject({ provider: z.literal("otlp"), endpointBaseUrl: baseUrl }),
]);
export type AgentObservabilityDestination = z.infer<typeof agentObservabilityDestinationSchema>;

/** Saved custom credentials belong to their HTTP origin, including scheme and port. */
export function isSameOtlpOrigin(previous: AgentObservabilityDestination, next: AgentObservabilityDestination): boolean {
  if (previous.provider !== "otlp" || next.provider !== "otlp") return false;
  try { return new URL(previous.endpointBaseUrl).origin === new URL(next.endpointBaseUrl).origin; }
  catch { return false; }
}

const forbiddenHeaders = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "accept", "accept-encoding"]);
const headerName = z.string().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
  .transform(value => value.toLowerCase()).refine(value => !forbiddenHeaders.has(value), "This header is managed by the transport.");
const headerValue = z.string().min(1).refine(value => !/[\x00-\x1f\x7f-\x9f]/.test(value), "Header values cannot contain control characters.")
  .refine(value => { try { encodeURIComponent(value); return true; } catch { return false; } }, "Header values must contain valid Unicode.")
  .refine(value => new TextEncoder().encode(value).length <= 4096, "Header values must be at most 4096 bytes.")
  .refine(value => !/^(?:\*{3,}|•{3,}|<redacted>|\[redacted\])$/i.test(value), "Enter the credential rather than a masked placeholder.");
export const agentObservabilityHeadersSchema = z.array(z.strictObject({ name: headerName, value: headerValue.optional() })).max(16)
  .superRefine((headers, ctx) => {
    if (new Set(headers.map(row => row.name)).size !== headers.length) ctx.addIssue({ code: "custom", message: "Header names must be unique." });
    if (headers.reduce((sum, row) => sum + new TextEncoder().encode(row.name + (row.value ?? "")).length, 0) > 16384) {
      ctx.addIssue({ code: "custom", message: "Headers must total at most 16 KiB." });
    }
  });
const common = {
  expectedRevision: z.string().uuid().nullable(), enabled: z.boolean(),
  capture: agentObservabilityCaptureSchema.default(DEFAULT_AGENT_OBSERVABILITY_CAPTURE),
};
const keep = z.strictObject({ mode: z.literal("keep") });
export const updateAgentObservabilitySchema = z.union([
  z.strictObject({ ...common,
    destination: z.strictObject({ provider: z.literal("braintrust"), projectId: z.string().uuid() }),
    credentials: z.discriminatedUnion("mode", [keep, z.strictObject({ mode: z.literal("replace"), apiKey: headerValue })]),
  }),
  z.strictObject({ ...common,
    destination: z.strictObject({ provider: z.literal("otlp"), endpointBaseUrl: baseUrl }),
    credentials: z.discriminatedUnion("mode", [keep, z.strictObject({ mode: z.literal("replace"), headers: agentObservabilityHeadersSchema })]),
  }),
]);
export type UpdateAgentObservabilityRequest = z.infer<typeof updateAgentObservabilitySchema>;
export const agentObservabilityRevisionSchema = z.strictObject({ expectedRevision: z.string().uuid() });
export type OtlpSignalTestResult = {
  status: "accepted" | "rejected" | "failed"; httpStatus: number | null;
  rejectedRecords: number; errorCode: string | null; message: string | null; durationMs: number;
};
export type AgentObservabilityTestReceipt = {
  revision: string; marker: string; source: "control_plane"; startedAt: string; finishedAt: string;
  status: "accepted" | "partial" | "failed";
  signals: { logs: OtlpSignalTestResult; traces: OtlpSignalTestResult };
};
export type AgentObservabilitySettings = {
  companyId: string; revision: string; enabled: boolean; destination: AgentObservabilityDestination;
  capture: AgentObservabilityCapture; credentialsConfigured: boolean; headerNames: string[];
  updatedAt: string; lastTest: AgentObservabilityTestReceipt | null;
};
export type AgentObservabilitySettingsResponse = { canManage: boolean; settings: AgentObservabilitySettings | null };

export type AgentObservabilityUnavailableReason =
  | "configuration_invalid" | "credentials_unavailable" | "unsupported_harness" | "unsupported_home_mode";
export type AgentObservabilityErrorCode =
  | "observability_revision_conflict" | "observability_credentials_required" | "observability_header_value_required"
  | AgentObservabilityUnavailableReason | "timeout" | "network_error" | "receiver_rejected" | "partial_rejection" | "invalid_response";
