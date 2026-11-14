import type { Page, Response, Request } from "@playwright/test";
import { JourneyError } from "./types.js";

export const onboardingServerCodes = ["agent_runner_config_incompatible", "agent_runner_unavailable", "agent_runner_platform_probe_failed", "managed_sandbox_unavailable", "environment_company_mismatch"] as const;
export const onboardingCheckCodes = ["adapter_auth_missing", "codex_hello_probe_failed", "codex_hello_probe_passed", "codex_hello_probe_timeout", "codex_hello_probe_auth_required", "environment_lease_acquire_failed", "environment_workspace_realize_failed", "environment_target_failed", "environment_target_unsupported", "environment_not_found", "environment_target_unavailable", "managed_sandbox_unavailable", "environment_env_binding_missing", "environment_env_resolution_failed", "ai_connection_api_key_rejected", "ai_connection_verification_failed", "sandbox_test_identity"] as const;
const checkpoints = ["connect", "validation", "hire", "review", "agent-verification"] as const;
const states = ["missing", "pending", "json", "unreadable", "oversized"] as const;
const requestedAdapters = ["codex_local", "paperclip_runner"] as const;
const adapters = ["codex_local", "paperclip_runner", "unrecognized"] as const;
const outcomes = ["pass", "warn", "fail", "unrecognized"] as const;
const levels = ["info", "warn", "error", "unrecognized"] as const;
type Known<T extends readonly string[]> = T[number] | "unrecognized";
export interface OnboardingResponseEvidence {
  state: typeof states[number]; httpStatus: number | null;
  requestedAdapter: "codex_local" | "paperclip_runner" | null;
  adapter: typeof adapters[number] | null; outcome: typeof outcomes[number] | null;
  serverCode: Known<typeof onboardingServerCodes> | null;
  checks: Array<{ code: Known<typeof onboardingCheckCodes>; level: typeof levels[number] }>;
  truncatedChecks: boolean;
}
export interface OnboardingConnectEvidence {
  version: 1; checkpoint: typeof checkpoints[number]; validation: OnboardingResponseEvidence; hire: OnboardingResponseEvidence;
}
const blank = (): OnboardingResponseEvidence => ({ state: "missing", httpStatus: null, requestedAdapter: null, adapter: null, outcome: null, serverCode: null, checks: [], truncatedChecks: false });
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const member = <T extends readonly string[]>(values: T, v: unknown): v is T[number] => typeof v === "string" && values.includes(v);
const closed = (v: unknown, keys: string[]) => record(v) && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
export function validateOnboardingConnectEvidence(value: unknown): void {
  if (!closed(value, ["version", "checkpoint", "validation", "hire"]) || !record(value) || value.version !== 1 || !member(checkpoints, value.checkpoint)) throw new Error("invalid_onboarding_connect_evidence");
  for (const response of [value.validation, value.hire]) {
    if (!closed(response, ["state", "httpStatus", "requestedAdapter", "adapter", "outcome", "serverCode", "checks", "truncatedChecks"]) || !record(response) ||
      !member(states, response.state) || !(response.httpStatus === null || Number.isSafeInteger(response.httpStatus) && Number(response.httpStatus) >= 100 && Number(response.httpStatus) <= 599) ||
      !(response.requestedAdapter === null || member(requestedAdapters, response.requestedAdapter)) ||
      !(response.adapter === null || member(adapters, response.adapter)) || !(response.outcome === null || member(outcomes, response.outcome)) ||
      !(response.serverCode === null || response.serverCode === "unrecognized" || member(onboardingServerCodes, response.serverCode)) ||
      typeof response.truncatedChecks !== "boolean" || !Array.isArray(response.checks) || response.checks.length > 32 ||
      response.checks.some(check => !closed(check, ["code", "level"]) || !record(check) || !(check.code === "unrecognized" || member(onboardingCheckCodes, check.code)) || !member(levels, check.level))) throw new Error("invalid_onboarding_connect_evidence");
  }
}

/** Observe only responses to this Connect action; never retain bodies, text, headers or browser errors. */
export async function onboardingConnect(input: { page: Page; origin: string; companyId: string; deadlineAt: number; retain(value: OnboardingConnectEvidence): void }): Promise<OnboardingConnectEvidence> {
  const { page } = input, receipt: OnboardingConnectEvidence = { version: 1, checkpoint: "connect", validation: blank(), hire: blank() };
  input.retain(receipt);
  let active = true, failure: JourneyError | undefined;
  let signalFailure!: (error: JourneyError) => void;
  const failed = new Promise<JourneyError>(resolve => { signalFailure = resolve; });
  const requests = new Set<Request>(), pending = new Set<Promise<void>>();
  const deadlineAt = Math.min(input.deadlineAt, Date.now() + 180_000);
  const remaining = () => Math.max(1, deadlineAt - Date.now());
  const advance = (checkpoint: OnboardingConnectEvidence["checkpoint"]) => {
    if (checkpoints.indexOf(checkpoint) > checkpoints.indexOf(receipt.checkpoint)) receipt.checkpoint = checkpoint;
  };
  const reject = (code: string) => { failure ??= new JourneyError("failed", code); signalFailure(failure); };
  const route = (request: Request): { kind: "validation" | "hire"; adapter: "codex_local" | "paperclip_runner" | null } | null => {
    try {
      const url = new URL(request.url());
      if (request.method() !== "POST" || url.origin !== input.origin || url.search || url.hash) return null;
      const prefix = `/api/companies/${encodeURIComponent(input.companyId)}`;
      if (url.pathname === `${prefix}/agent-hires`) return { kind: "hire", adapter: null };
      for (const adapter of ["codex_local", "paperclip_runner"] as const) if (url.pathname === `${prefix}/adapters/${adapter}/test-environment`) return { kind: "validation", adapter };
    } catch { /* An unrelated or malformed URL is not this action's evidence. */ }
    return null;
  };
  const onRequest = (request: Request) => { if (active && route(request)) requests.add(request); };
  const onResponse = (response: Response) => {
    const request = response.request(), matched = route(request);
    if (!active || !matched || !requests.delete(request)) return;
    const observed = receipt[matched.kind];
    // One Connect action can report each boundary once. Later traffic cannot replace its failure.
    if (observed.state !== "missing") return;
    advance(matched.kind); observed.state = "pending";
    const status = response.status();
    observed.httpStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
    observed.requestedAdapter = matched.adapter;
    if (response.status() >= 400) reject(matched.kind === "validation" ? "onboarding_native_validation_failed" : "onboarding_agent_hire_failed");
    const classify = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const bytes = await Promise.race([response.body(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.min(5000, remaining())); })]);
        if (!active) return;
        if (!bytes) { observed.state = "unreadable"; return; }
        if (bytes.byteLength > 65_536) { observed.state = "oversized"; return; }
        let body: unknown; try { body = JSON.parse(bytes.toString("utf8")); } catch { observed.state = "unreadable"; return; }
        if (!record(body)) { observed.state = "unreadable"; return; }
        observed.state = "json";
        const detailCode = record(body.details) ? body.details.code : undefined;
        const code = member(onboardingServerCodes, detailCode) ? detailCode : member(onboardingServerCodes, body.code) ? body.code : detailCode ?? body.code;
        if (code !== undefined) observed.serverCode = member(onboardingServerCodes, code) ? code : "unrecognized";
        if (matched.kind === "validation") {
          observed.adapter = member(adapters, body.adapterType) ? body.adapterType : "unrecognized";
          observed.outcome = member(outcomes, body.status) ? body.status : "unrecognized";
          if (Array.isArray(body.checks)) {
            observed.truncatedChecks = body.checks.length > 32;
            observed.checks = body.checks.slice(0, 32).map(check => ({ code: record(check) && member(onboardingCheckCodes, check.code) ? check.code : "unrecognized", level: record(check) && member(levels, check.level) ? check.level : "unrecognized" }));
            if (body.status === "fail" || body.checks.some(check => record(check) && check.code === "adapter_auth_missing")) reject("onboarding_native_validation_failed");
          } else if (body.status === "fail") reject("onboarding_native_validation_failed");
        }
      } catch { if (active) observed.state = "unreadable"; }
      finally { clearTimeout(timer); }
    };
    const work = classify(); pending.add(work); void work.then(() => pending.delete(work), () => pending.delete(work));
  };
  page.on("request", onRequest); page.on("response", onResponse);
  try {
    if (Date.now() >= deadlineAt) throw new JourneyError("failed", "onboarding_connect_timeout");
    const clicked = page.getByRole("button", { name: "Connect", exact: true }).click({ timeout: remaining() })
      .then(() => null, error => new JourneyError("failed", error?.name === "TimeoutError" ? "onboarding_connect_timeout" : "onboarding_connect_failed"));
    const clickResult = await Promise.race([failed, clicked]);
    if (clickResult) throw clickResult;
    if (failure) throw failure;
    const result = await Promise.race([failed, page.getByRole("button", { name: "Get started", exact: true }).waitFor({ timeout: remaining() })
      .then(() => null, error => new JourneyError("failed", error?.name === "TimeoutError" ? "onboarding_get_started_timeout" : "onboarding_get_started_failed"))]);
    const boundaryFailure = failure;
    // Seal the observed boundary before awaiting body reads. A response arriving
    // after Get started or its timeout cannot change this action's outcome.
    page.off("request", onRequest); page.off("response", onResponse);
    if (pending.size) await Promise.all([...pending]);
    if (boundaryFailure) throw boundaryFailure;
    if (result) throw result;
    if (failure) throw failure;
    if (Date.now() >= deadlineAt) throw new JourneyError("failed", "onboarding_get_started_timeout");
    advance("review");
    return receipt;
  } finally {
    // Settle only already observed responses within their bounded read; detach before later traffic.
    page.off("request", onRequest); page.off("response", onResponse);
    if (pending.size) await Promise.all([...pending]);
    active = false; requests.clear();
  }
}
