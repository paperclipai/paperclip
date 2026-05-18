/**
 * LET-396 — Typed capability-apply API client.
 *
 * Wraps the LET-357 / LET-395 server routes:
 *   POST   /companies/:companyId/agents/:agentId/capability-apply/plans
 *   GET    /companies/:companyId/agents/:agentId/capability-apply/plans/:planId
 *   POST   /.../plans/:planId/request-approval     (If-Match)
 *   POST   /.../plans/:planId/execute              (If-Match)
 *   POST   /.../plans/:planId/cancel               (If-Match)
 *   GET    /.../plans/:planId/events
 *
 * Error responses are translated to {@link CapabilityApplyApiError} so the UI
 * can branch on stable `code` values from `@paperclipai/shared`'s
 * `CAPABILITY_APPLY_ERROR_CODES`.
 */
import type {
  CapabilityApplyApprovalPayload,
  CapabilityApplyEvent,
  CapabilityApplyPlanInput,
  CapabilityApplyPlanSummary,
} from "@paperclipai/shared";

const BASE = "/api";

export class CapabilityApplyApiError extends Error {
  status: number;
  code: string | null;
  details: Record<string, unknown> | null;

  constructor(message: string, status: number, code: string | null, details: Record<string, unknown> | null) {
    super(message);
    this.name = "CapabilityApplyApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function parseErrorBody(res: Response): Promise<CapabilityApplyApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  const message =
    (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
      ? (body as { error: string }).error
      : `Request failed: ${res.status}`) ?? `Request failed: ${res.status}`;
  const details =
    body && typeof body === "object" && "details" in body && typeof (body as { details: unknown }).details === "object"
      ? ((body as { details: Record<string, unknown> }).details ?? null)
      : null;
  const code =
    details && typeof details.code === "string"
      ? details.code
      : // The server sets HttpError(message=<code>) for capability-apply violations,
        // so the bare `error` string is also the stable code.
        typeof message === "string"
        ? message
        : null;
  return new CapabilityApplyApiError(message, res.status, code, details);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? undefined);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`${BASE}${path}`, { credentials: "include", ...init, headers });
  if (!res.ok) throw await parseErrorBody(res);
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface RequestApprovalResult {
  plan: CapabilityApplyPlanSummary;
  approvalPayload: CapabilityApplyApprovalPayload;
}

export const capabilityApplyApi = {
  createPlan: (
    companyId: string,
    agentId: string,
    body: { effectiveDelta: CapabilityApplyPlanInput["effectiveDelta"]; proposalIdentity?: string },
  ) =>
    call<CapabilityApplyPlanSummary>(
      `/companies/${companyId}/agents/${agentId}/capability-apply/plans`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  getPlan: (companyId: string, agentId: string, planId: string) =>
    call<CapabilityApplyPlanSummary>(
      `/companies/${companyId}/agents/${agentId}/capability-apply/plans/${planId}`,
    ),

  requestApproval: (companyId: string, agentId: string, planId: string, ifMatch: number) =>
    call<RequestApprovalResult>(
      `/companies/${companyId}/agents/${agentId}/capability-apply/plans/${planId}/request-approval`,
      { method: "POST", headers: { "If-Match": String(ifMatch) }, body: "{}" },
    ),

  execute: (companyId: string, agentId: string, planId: string, ifMatch: number) =>
    call<CapabilityApplyPlanSummary>(
      `/companies/${companyId}/agents/${agentId}/capability-apply/plans/${planId}/execute`,
      { method: "POST", headers: { "If-Match": String(ifMatch) }, body: "{}" },
    ),

  cancel: (companyId: string, agentId: string, planId: string, ifMatch: number) =>
    call<CapabilityApplyPlanSummary>(
      `/companies/${companyId}/agents/${agentId}/capability-apply/plans/${planId}/cancel`,
      { method: "POST", headers: { "If-Match": String(ifMatch) }, body: "{}" },
    ),

  listEvents: (companyId: string, agentId: string, planId: string) =>
    call<CapabilityApplyEvent[]>(
      `/companies/${companyId}/agents/${agentId}/capability-apply/plans/${planId}/events`,
    ),
};
