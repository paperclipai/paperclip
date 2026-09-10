import type { Db } from "@paperclipai/db";
import type { DeliveryCheck } from "@paperclipai/shared";
import type { ToolGatewayService } from "../tool-gateway.js";

/**
 * Scoped Greptile read.
 *
 * Greptile is reached through the connected MCP tool gateway. The controller
 * passes only identifiers derived from the delivery unit — never a
 * caller-supplied repository, tool name, or argument — and the gateway
 * allowlists both the tool and the argument keys. A missing or unusable
 * connection fails closed: an unknown review is a blocker, never a pass.
 */

export const GREPTILE_READ_TOOL_NAMES = [
  "get_merge_request",
  "list_merge_request_comments",
] as const;

export const GREPTILE_READ_PARAMETER_KEYS = [
  "name",
  "remote",
  "defaultBranch",
  "prNumber",
] as const;

export type GreptileFinding = {
  externalId: string;
  severity: string;
  title: string;
  body: string | null;
  filePath: string | null;
  line: number | null;
  url: string | null;
  blocking: boolean;
};

export type GreptileReview = {
  ok: true;
  status: "approved" | "changes_requested" | "commented" | "none";
  headSha: string | null;
  blockingFindings: number;
  findings: GreptileFinding[];
  raw: unknown;
};

export type GreptileReadFailure = {
  ok: false;
  errorCode: string;
  message: string;
};

export type GreptileReadResult = GreptileReview | GreptileReadFailure;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** MCP tool results may be a JSON-RPC result object or a bare payload. */
export function parseMcpToolPayload(result: unknown): unknown {
  const outer = record(result);
  if (!outer) return result;
  if (outer.structuredContent !== undefined) return outer.structuredContent;
  const content = array(outer.content);
  for (const entry of content) {
    const item = record(entry);
    const text = str(item?.text);
    if (!text) continue;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return outer;
}

function severityOf(row: Record<string, unknown>) {
  const raw = str(row.severity) ?? str(row.priority) ?? str(row.level) ?? str(row.category);
  return raw ? raw.toLowerCase() : "unknown";
}

function isBlocking(row: Record<string, unknown>, severity: string) {
  if (row.blocking === true) return true;
  if (row.blocking === false) return false;
  return severity === "critical" || severity === "high" || severity === "error" || severity === "blocker";
}

function normalizeFinding(row: Record<string, unknown>, index: number): GreptileFinding | null {
  const severity = severityOf(row);
  const title = str(row.title) ?? str(row.summary) ?? str(row.message) ?? str(row.comment) ?? str(row.body);
  if (!title) return null;
  const filePath = str(row.filePath) ?? str(row.file) ?? str(row.path) ?? str(row.filename);
  return {
    externalId: str(row.id) ?? str(row.commentId) ?? str(row.uuid) ?? `${filePath ?? "finding"}:${index}`,
    severity,
    title: title.length > 2000 ? `${title.slice(0, 2000)}…` : title,
    body: str(row.body) ?? str(row.details) ?? str(row.description) ?? null,
    filePath,
    line: num(row.line) ?? num(row.lineNumber) ?? num(row.startLine),
    url: str(row.url) ?? str(row.htmlUrl) ?? str(row.link),
    blocking: isBlocking(row, severity),
  };
}

function extractFindings(payload: unknown): GreptileFinding[] {
  const root = record(payload);
  if (!root) return [];
  const containers = [
    root.findings,
    root.comments,
    root.issues,
    root.reviewComments,
    root.review_comments,
    record(root.mergeRequest)?.comments,
    record(root.data)?.findings,
    record(root.data)?.comments,
  ];
  const findings: GreptileFinding[] = [];
  for (const container of containers) {
    for (const [index, entry] of array(container).entries()) {
      const row = record(entry);
      if (!row) continue;
      const normalized = normalizeFinding(row, index);
      if (normalized && !findings.some((finding) => finding.externalId === normalized.externalId)) {
        findings.push(normalized);
      }
    }
  }
  return findings;
}

export interface GreptileReviewService {
  read(input: {
    companyId: string;
    connectionId: string | null;
    repositoryName: string;
    defaultBranch: string;
    prNumber: number;
    /** Candidate revision under review; distinct from the verified accepted head. */
    submittedHeadSha: string | null;
    /** Verified accepted revision, if any. Never used as the review target. */
    acceptedHeadSha: string | null;
    checks: DeliveryCheck[];
  }): Promise<GreptileReadResult>;
}

export function greptileReviewService(
  db: Db,
  deps: { toolGateway: Pick<ToolGatewayService, "readConnectedTool"> },
): GreptileReviewService {
  async function read(input: {
    companyId: string;
    connectionId: string | null;
    repositoryName: string;
    defaultBranch: string;
    prNumber: number;
    submittedHeadSha: string | null;
    acceptedHeadSha: string | null;
    checks: DeliveryCheck[];
  }): Promise<GreptileReadResult> {
    if (!input.connectionId) {
      return {
        ok: false,
        errorCode: "connection_missing",
        message: "Policy requires Greptile but no Greptile connection is configured",
      };
    }
    const parameters = {
      name: input.repositoryName,
      remote: "github",
      defaultBranch: input.defaultBranch,
      prNumber: input.prNumber,
    };
    const review = await deps.toolGateway.readConnectedTool({
      companyId: input.companyId,
      connectionId: input.connectionId,
      toolName: "get_merge_request",
      allowedToolNames: GREPTILE_READ_TOOL_NAMES,
      allowedParameterKeys: GREPTILE_READ_PARAMETER_KEYS,
      parameters,
      reason: "delivery_review_read",
    });
    if (!review.ok) return { ok: false, errorCode: review.errorCode, message: review.message };
    const comments = await deps.toolGateway.readConnectedTool({
      companyId: input.companyId,
      connectionId: input.connectionId,
      toolName: "list_merge_request_comments",
      allowedToolNames: GREPTILE_READ_TOOL_NAMES,
      allowedParameterKeys: GREPTILE_READ_PARAMETER_KEYS,
      parameters,
      reason: "delivery_review_comments",
    });
    // Both reads are required for a complete review: a failed comments read
    // is a failed read, never a silent partial success over review-only
    // findings.
    if (!comments.ok) return { ok: false, errorCode: comments.errorCode, message: comments.message };
    const reviewPayload = parseMcpToolPayload(review.result);
    const commentsPayload = parseMcpToolPayload(comments.result);
    const findings = [
      ...extractFindings(reviewPayload),
      ...extractFindings(commentsPayload),
    ];
    const deduped = [...new Map(findings.map((finding) => [finding.externalId, finding])).values()];
    const blockingFindings = deduped.filter((finding) => finding.blocking).length;
    const reviewRoot = record(reviewPayload);
    const headSha = str(reviewRoot?.headSha) ?? str(reviewRoot?.commitSha) ?? str(reviewRoot?.sha) ?? null;
    const explicitStatus = str(reviewRoot?.status) ?? str(reviewRoot?.state);
    const status = blockingFindings > 0
      ? "changes_requested"
      : explicitStatus === "approved" || reviewRoot?.approved === true
        ? "approved"
        : deduped.length > 0
          ? "commented"
          : "none";
    return {
      ok: true,
      status,
      headSha,
      blockingFindings,
      findings: deduped,
      raw: { review: reviewPayload, comments: commentsPayload },
    };
  }

  return { read };
}
