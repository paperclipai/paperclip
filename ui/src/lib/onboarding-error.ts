import { ApiError } from "../api/client";

export type OnboardingErrorClass =
  | "validation"
  | "name_conflict"
  | "adapter_environment"
  | "unknown_server_error"
  | "network";

export interface ValidationFieldError {
  path: string;
  message: string;
}

export interface CategorizedOnboardingError {
  class: OnboardingErrorClass;
  status: number | null;
  serverMessage: string | null;
  incidentId: string | null;
  fields: ValidationFieldError[];
}

interface AnyRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractIncidentId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const candidate = body.incidentId ?? body.issueIdentifier ?? body.issueId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function extractServerMessage(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.error === "string" && body.error.length > 0) return body.error;
  if (typeof body.message === "string" && body.message.length > 0) return body.message;
  return null;
}

function extractZodFieldErrors(body: unknown): ValidationFieldError[] {
  if (!isRecord(body)) return [];
  const details = body.details;
  if (!Array.isArray(details)) return [];
  const out: ValidationFieldError[] = [];
  for (const entry of details) {
    if (!isRecord(entry)) continue;
    const message = typeof entry.message === "string" ? entry.message : null;
    if (!message) continue;
    const path = Array.isArray(entry.path)
      ? entry.path.filter((p) => typeof p === "string" || typeof p === "number").join(".")
      : typeof entry.path === "string"
        ? entry.path
        : "";
    out.push({ path, message });
  }
  return out;
}

/**
 * Categorize any error thrown from an onboarding API call into one of the
 * `OnboardingErrorClass` buckets so the UI can render friendly copy + retry.
 *
 * Never returns raw `err.message` for rendering — `serverMessage` is exposed
 * only so callers can show it as supplemental detail when desired.
 */
export function categorizeOnboardingError(err: unknown): CategorizedOnboardingError {
  if (err instanceof ApiError) {
    const status = err.status;
    const serverMessage = extractServerMessage(err.body) ?? err.message ?? null;
    const incidentId = extractIncidentId(err.body);

    if (status >= 500) {
      return { class: "unknown_server_error", status, serverMessage, incidentId, fields: [] };
    }
    if (status === 409) {
      return { class: "name_conflict", status, serverMessage, incidentId, fields: [] };
    }
    if (status >= 400 && status < 500) {
      return {
        class: "validation",
        status,
        serverMessage,
        incidentId,
        fields: extractZodFieldErrors(err.body),
      };
    }
    return { class: "unknown_server_error", status, serverMessage, incidentId, fields: [] };
  }

  // fetch() throws TypeError (or DOMException for abort) when the network
  // is unreachable — no response was produced. Narrow TypeError by message so a
  // plain JS null-deref doesn't get misclassified as "Couldn't reach Paperclip."
  const isFetchNetworkError =
    err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
  const isAbortError =
    typeof DOMException !== "undefined" && err instanceof DOMException;
  if (isFetchNetworkError || isAbortError) {
    return {
      class: "network",
      status: null,
      serverMessage: err instanceof Error ? err.message : null,
      incidentId: null,
      fields: [],
    };
  }

  // Catch-all: treat as unknown server error so the user still gets a retry
  // affordance rather than a dead-end. We never leak the raw message into the
  // banner — copy is sourced from `onboarding-error-copy.ts`.
  // Log so the "We've logged it." copy is honest and DevTools/Sentry get a signal.
  console.error("[onboarding] uncategorized error", err);
  return {
    class: "unknown_server_error",
    status: null,
    serverMessage: err instanceof Error ? err.message : null,
    incidentId: null,
    fields: [],
  };
}
