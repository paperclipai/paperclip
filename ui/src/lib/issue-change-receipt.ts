import { i18n, t } from "@/i18n";
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
  get "assigneeAgentId"() { return t("display:meta_049e3ce5476a"); },
  get "assigneeUserId"() { return t("display:meta_381018cc89e0"); },
  get "responsibleUserId"() { return t("display:meta_59fcd1b2e820"); },
  get "blockedByIssueIds"() { return t("display:meta_699edf83caae"); },
  get "labelIds"() { return t("display:meta_2228985493d9"); },
  get "parentId"() { return t("display:meta_23d692f07a3f"); },
  get "projectId"() { return t("display:meta_f6f4da8d93e8"); },
  get "goalId"() { return t("display:meta_9fe00acebc10"); },
  get "workMode"() { return t("display:meta_70b0f86ed005"); },
  get "reviewPolicy"() { return t("display:meta_0fffc79d22b6"); },
  get "billingCode"() { return t("display:meta_36799c1aa946"); },
  get "checkoutRunId"() { return t("display:meta_6c535060c1b5"); },
  get "executionRunId"() { return t("display:meta_9df68de6460f"); },
  get "hiddenAt"() { return t("display:meta_d4c2792a7245"); },
  get "startedAt"() { return t("display:meta_faa9e7e7ef5a"); },
  get "completedAt"() { return t("display:meta_1798b3ba42ee"); },
  get "cancelledAt"() { return t("display:meta_a1bf92eff40d"); },
  get "requestDepth"() { return t("display:meta_6e872e2eafd7"); },
  get "sourceTrust"() { return t("display:meta_c0596856adf9"); },
  get "executionPolicy"() { return t("display:meta_e916a115bd34"); },
  get "executionWorkspaceId"() { return t("display:meta_60a2168a43da"); },
  get "projectWorkspaceId"() { return t("display:meta_0fbbdbe387f0"); },
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
  if (value === null || value === undefined || value === "") return t("display:copy_dad21718d13b");
  if (typeof value === "boolean") return value ? t("display:copy_47418af5e1a7") : t("display:copy_84d522b31e7b");
  if (typeof value === "number") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return t("display:copy_dad21718d13b");
    const strings = value.filter((entry): entry is string => typeof entry === "string");
    if (strings.length !== value.length) return t("display:copy_7fb8a4c62b08", { value0: value.length });
    return strings.length <= 3
      ? strings.map((id) => shortenId(id)).join(", ")
      : t("display:copy_7fb8a4c62b08", { value0: strings.length });
  }

  if (value instanceof Date) return value.toLocaleString(i18n.language);

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return t("display:copy_dad21718d13b");
    // Ids resolve to names when the directory is loaded; otherwise they shorten.
    const resolved = options.field?.toLowerCase().includes("agent")
      ? options.resolveAgentLabel?.(trimmed)
      : options.field?.toLowerCase().includes("user")
        ? options.resolveUserLabel?.(trimmed)
        : null;
    if (resolved) return resolved;
    if (isIsoTimestamp(trimmed)) return new Date(trimmed).toLocaleString(i18n.language);
    if (looksLikeId(trimmed)) return shortenId(trimmed);
    if (["status", "priority", "workMode"].includes(options.field ?? "")) return t(`display:activity_value_${trimmed}`, { defaultValue: trimmed.replace(/_/g, " ") });
    const humanized = trimmed.includes(" ") ? trimmed : trimmed.replace(/_/g, " ");
    return truncate(humanized);
  }

  // Objects (execution policy, workspace settings) are structural — the receipt
  // records that they moved, and the audit log holds the full value.
  return t("display:copy_bafd284dbc4f");
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
  get "allow_visible_issue_write"() { return t("display:meta_7a02ad89d6dd"); },
  get "allow_scoped_agent_write"() { return t("display:meta_a80a6ce9fa21"); },
  get "allow_board_actor"() { return t("display:meta_70c34f0c0f68"); },
  get "allow_self"() { return t("display:meta_45c58f08dac3"); },
  get "allow_issue_mention_grant"() { return t("display:meta_02609a675e35"); },
  get "allow_direct_parent_report"() { return t("display:meta_dd96cab94cfd"); },
  get "allow_low_trust_boundary"() { return t("display:meta_a2d5ed57a185"); },
  get "allow_explicit_grant"() { return t("display:meta_4665715b19ee"); },
  get "allow_instance_admin"() { return t("display:meta_f65d66aec47b"); },
  get "allow_local_board"() { return t("display:meta_1d36d43cc3ea"); },
  get "internal_agent_write"() { return t("display:meta_203a640f4e67"); },
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
