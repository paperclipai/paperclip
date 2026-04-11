import type { IssueQaGateReasonCode } from "@paperclipai/shared";
import { ApiError } from "../api/client";

const REASON_TEXT: Record<IssueQaGateReasonCode, { title: string; body: string }> = {
  invalid_status_transition: {
    title: "Invalid status move",
    body: "That status change is not allowed by the issue workflow.",
  },
  qa_gate_requires_in_review: {
    title: "Ship blocked: move to QA first",
    body: "Delivery issues can only ship to Done from QA (in_review).",
  },
  qa_gate_missing_qa_pass: {
    title: "Ship blocked: missing QA PASS",
    body: "The latest QA-authored comment must include [QA PASS].",
  },
  qa_gate_missing_release_confirmation: {
    title: "Ship blocked: missing release confirmation",
    body: "The latest QA-authored comment must include [RELEASE CONFIRMED].",
  },
};

export function describeIssueUpdateError(err: unknown): { title: string; body?: string } {
  if (!(err instanceof ApiError)) {
    return {
      title: "Issue update failed",
      body: err instanceof Error ? err.message : "Unable to update issue",
    };
  }

  const body = err.body && typeof err.body === "object" ? (err.body as Record<string, unknown>) : null;
  const reasonCode = typeof body?.reasonCode === "string"
    ? (body.reasonCode as IssueQaGateReasonCode)
    : null;

  if (reasonCode && REASON_TEXT[reasonCode]) {
    const fallbackMessage = typeof body?.message === "string" ? body.message : undefined;
    return {
      title: REASON_TEXT[reasonCode].title,
      body: fallbackMessage ?? REASON_TEXT[reasonCode].body,
    };
  }

  return {
    title: "Issue update failed",
    body: typeof body?.error === "string" ? body.error : err.message,
  };
}

