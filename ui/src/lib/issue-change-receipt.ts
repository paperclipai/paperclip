import { i18n, t } from "@/i18n";
import { entityStatusLabel, entityPriorityLabel } from "@/lib/entity-labels";
import { isIssueWorkMode, workModeMetaFor } from "@/lib/work-mode-meta";
import { formatDateTime } from "@/lib/utils";
import type { IssueChangeReceiptEntry } from "@paperclipai/shared";
import { formatReviewPolicyValue } from "./review-policy";

/**
 * Read + format the field-level change receipts carried on an `issue.updated`
 * activity event (the open cross-task write design (audit), built on the field-change receipts the API already records).
 *
 * Every issue PATCH — agent and board alike — must leave an auditable record of
 * who changed what, when, and under which authorization. The server writes that
 * receipt; this module turns it into something a human can scan in the activity
 * stream without opening the audit log.
 *
 * The server already drops `updatedAt` and truncates long text (flagging it with
 * `updated: true`), so this module renders what it is given rather than
 * re-deciding what is interesting.
 */

/** Field names whose raw ids carry no meaning in a scannable summary. */
const FIELD_LABELS: Record<string, string> = {
  assigneeAgentId: "Assignee",
  assigneeUserId: "Assignee (user)",
  responsibleUserId: "Responsible user",
  blockedByIssueIds: "Blockers",
  labelIds: "Labels",
  parentId: "Parent",
  projectId: "Project",
  goalId: "Goal",
  workMode: "Work mode",
  reviewPolicy: "Who can approve",
  billingCode: "Billing code",
  checkoutRunId: "Checkout run",
  executionRunId: "Execution run",
  hiddenAt: "Hidden",
  startedAt: "Started",
  completedAt: "Completed",
  cancelledAt: "Cancelled",
  requestDepth: "Request depth",
  sourceTrust: "Source trust",
  executionPolicy: "Execution policy",
  executionWorkspaceId: "Execution workspace",
  projectWorkspaceId: "Project workspace",
};

/** Human label for a changed field, e.g. `assigneeAgentId` → "Assignee". */
export function issueChangeFieldLabel(field: string): string {
  const known = FIELD_LABELS[field];
  if (known) return known;
  // camelCase / snake_case → "Sentence case".
  const spaced = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const VALUE_PREVIEW_BUDGET = 72;

/**
 * Render one side of a change for display. Never returns an empty string, so a
 * receipt row always reads as "from → to" rather than trailing into nothing.
 */
export function formatIssueChangeValue(
  value: unknown,
  options: { resolveAgentLabel?: (id: string) => string | null | undefined;
    resolveUserLabel?: (id: string) => string | null | undefined;
    field?: string } = {},
): string {
  // `reviewPolicy` is nullable-by-default: a cleared column means "anyone can
  // approve", not "no value" (PAP-16506), so it resolves before the null branch.
  if (options.field === "reviewPolicy") return formatReviewPolicyValue(value);
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    const strings = value.filter((entry): entry is string => typeof entry === "string");
    if (strings.length !== value.length) return `${value.length} items`;
    return strings.length <= 3
      ? strings.map((id) => shortenId(id)).join(", ")
      : `${strings.length} items`;
  }

  if (value instanceof Date) return value.toLocaleString();

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "none";
    // Ids resolve to names when the directory is loaded; otherwise they shorten.
    const resolved = options.field?.toLowerCase().includes("agent")
      ? options.resolveAgentLabel?.(trimmed)
      : options.field?.toLowerCase().includes("user")
        ? options.resolveUserLabel?.(trimmed)
        : null;
    if (resolved) return resolved;
    if (isIsoTimestamp(trimmed)) return new Date(trimmed).toLocaleString();
    if (looksLikeId(trimmed)) return shortenId(trimmed);
    const humanized = trimmed.includes(" ") ? trimmed : trimmed.replace(/_/g, " ");
    return truncate(humanized);
  }

  // Objects (execution policy, workspace settings) are structural — the receipt
  // records that they moved, and the audit log holds the full value.
  return "updated";
}

function truncate(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= VALUE_PREVIEW_BUDGET) return value;
  return `${chars.slice(0, VALUE_PREVIEW_BUDGET).join("")}…`;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

function looksLikeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function shortenId(value: string): string {
  return looksLikeId(value) ? value.slice(0, 8) : truncate(value);
}

export interface IssueChangeReceiptRow {
  field: string;
  label: string;
  from: string;
  to: string;
  /** Server flagged the values as truncated previews of long text. */
  truncated: boolean;
}

function isChangeEntry(value: unknown): value is IssueChangeReceiptEntry {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && "from" in (value as object) && "to" in (value as object);
}

/**
 * Parse `details.changes` off an activity event into display rows. Returns an
 * empty array for events with no receipt (older rows, non-PATCH actions), so
 * callers can render nothing without special-casing.
 */
export function readIssueChangeReceipt(
  details: Record<string, unknown> | null | undefined,
  options: Parameters<typeof formatIssueChangeValue>[1] = {},
): IssueChangeReceiptRow[] {
  const changes = details?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];

  const rows: IssueChangeReceiptRow[] = [];
  for (const [field, entry] of Object.entries(changes as Record<string, unknown>)) {
    if (!isChangeEntry(entry)) continue;
    rows.push({
      field,
      label: issueChangeFieldLabel(field),
      from: formatIssueChangeValue(entry.from, { ...options, field }),
      to: formatIssueChangeValue(entry.to, { ...options, field }),
      truncated: entry.updated === true,
    });
  }
  // Stable, scannable order regardless of JSON key order (jsonb reorders keys).
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

/** Authorization reasons, as recorded by the server's write-policy decision. */
const AUTHORIZATION_REASON_LABELS: Record<string, string> = {
  allow_visible_issue_write: "default-open write on a visible task",
  allow_scoped_agent_write: "scoped agent write",
  allow_board_actor: "board actor",
  allow_self: "own task",
  allow_issue_mention_grant: "mention grant",
  allow_direct_parent_report: "direct parent report",
  allow_low_trust_boundary: "low-trust boundary allowance",
  allow_explicit_grant: "explicit permission grant",
  allow_instance_admin: "instance admin",
  allow_local_board: "local board",
  internal_agent_write: "internal agent write",
};

/**
 * Human phrasing for the authorization reason on a write receipt. Unknown
 * reasons degrade to their humanized code rather than disappearing — an
 * unexplained write is worse than an ugly one.
 */
export function issueAuthorizationReasonLabel(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim();
  if (!trimmed) return null;
  return AUTHORIZATION_REASON_LABELS[trimmed] ?? trimmed.replace(/_/g, " ");
}

// Display adapters deliberately reuse the raw receipt parser/order; field codes
// and saved previews must never become locale-dependent.
export function issueChangeFieldLabelDisplay(field: string): string {
  const keys: Record<string, string> = {
    "assigneeAgentId": "localizationIssuePanels.field_assigneeAgentId",
    "assigneeUserId": "localizationIssuePanels.field_assigneeUserId",
    "responsibleUserId": "localizationIssuePanels.field_responsibleUserId",
    "blockedByIssueIds": "localizationIssuePanels.field_blockedByIssueIds",
    "labelIds": "localizationIssuePanels.field_labelIds",
    "parentId": "localizationIssuePanels.field_parentId",
    "projectId": "localizationIssuePanels.field_projectId",
    "goalId": "localizationIssuePanels.field_goalId",
    "workMode": "localizationIssuePanels.field_workMode",
    "reviewPolicy": "localizationIssuePanels.field_reviewPolicy",
    "billingCode": "localizationIssuePanels.field_billingCode",
    "checkoutRunId": "localizationIssuePanels.field_checkoutRunId",
    "executionRunId": "localizationIssuePanels.field_executionRunId",
    "hiddenAt": "localizationIssuePanels.field_hiddenAt",
    "startedAt": "localizationIssuePanels.field_startedAt",
    "completedAt": "localizationIssuePanels.field_completedAt",
    "cancelledAt": "localizationIssuePanels.field_cancelledAt",
    "requestDepth": "localizationIssuePanels.field_requestDepth",
    "sourceTrust": "localizationIssuePanels.field_sourceTrust",
    "executionPolicy": "localizationIssuePanels.field_executionPolicy",
    "executionWorkspaceId": "localizationIssuePanels.field_executionWorkspaceId",
    "projectWorkspaceId": "localizationIssuePanels.field_projectWorkspaceId",
    "title": "localizationIssuePanels.field_title",
    "description": "localizationIssuePanels.field_description",
    "status": "localizationIssuePanels.field_status",
    "priority": "localizationIssuePanels.field_priority",
  };
  return keys[field] ? t(keys[field]) : issueChangeFieldLabel(field);
}

export function formatIssueChangeValueDisplay(value: unknown, options: Parameters<typeof formatIssueChangeValue>[1] = {}): string {
  const raw = formatIssueChangeValue(value, options);
  if (i18n.resolvedLanguage === "en" || options.field === "reviewPolicy") return raw;
  if (value === null || value === undefined || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length)) return t("localizationIssuePanels.valueNone");
  if (typeof value === "boolean") return t(value ? "localizationIssuePanels.valueYes" : "localizationIssuePanels.valueNo");
  if (Array.isArray(value)) {
    return value.length > 3 || value.some((entry) => typeof entry !== "string")
      ? t("localizationIssuePanels.valueItems", { count: value.length })
      : raw;
  }
  if (value instanceof Date) return formatDateTime(value);
  if (typeof value === "string") {
    if (isIsoTimestamp(value.trim())) return formatDateTime(value.trim());
    if (options.field === "status") return entityStatusLabel(value);
    if (options.field === "priority") return entityPriorityLabel(value);
    if (options.field === "workMode" && isIssueWorkMode(value)) return workModeMetaFor(value).label;
    return raw;
  }
  return typeof value === "number" ? raw : t("localizationIssuePanels.valueUpdated");
}

export function readIssueChangeReceiptDisplay(
  details: Record<string, unknown> | null | undefined,
  options: Parameters<typeof formatIssueChangeValue>[1] = {},
): IssueChangeReceiptRow[] {
  return readIssueChangeReceipt(details, options).map((row) => {
    const entry = (details!.changes as Record<string, IssueChangeReceiptEntry>)[row.field];
    return {
      ...row,
      label: issueChangeFieldLabelDisplay(row.field),
      from: formatIssueChangeValueDisplay(entry.from, { ...options, field: row.field }),
      to: formatIssueChangeValueDisplay(entry.to, { ...options, field: row.field }),
    };
  });
}

export function issueAuthorizationReasonLabelDisplay(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim();
  if (!trimmed) return null;
  return Object.hasOwn(AUTHORIZATION_REASON_LABELS, trimmed)
    ? t(`localizationIssuePanels.authorization_${trimmed}`)
    : issueAuthorizationReasonLabel(reason);
}
