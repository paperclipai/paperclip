/**
 * Builds the only text that leaves Paperclip: a fixed title, a fixed tag, a
 * fixed sentence, an optional issue identifier, and a click link into the
 * Paperclip UI.
 */

export const MESSAGE_PREFIX = "A decision is waiting";
/** Fixed ntfy `Title`; only the canonical issue identifier may follow it. */
export const TITLE_PREFIX = "Paperclip decision";
/** Fixed ntfy `Tags` value on every publish. */
export const MESSAGE_TAGS = "paperclip";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9]{1,16}-[0-9]{1,12}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9]{1,16}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MessageTarget {
  /** Company issue prefix, e.g. `ABC`. */
  issuePrefix: string | null;
  /** Issue identifier, e.g. `ABC-12`, when the plugin may read the issue. */
  issueIdentifier: string | null;
  /** Issue UUID, used for the link when the identifier is not readable. */
  issueId: string | null;
  /** Approval UUID, used for the link when no issue is linked. */
  approvalId: string | null;
  /** Board decision UUID; the link opens the decision queue on it. */
  decisionId?: string | null;
  /**
   * Fixed word for the body when no issue is linked at all, e.g. `approval`.
   * It is never derived from event text.
   */
  fallbackLabel?: FallbackLabel | null;
}

export type FallbackLabel = "approval" | "decision";
const FALLBACK_LABELS: ReadonlySet<string> = new Set<FallbackLabel>(["approval", "decision"]);

export function isSafeIdentifier(value: string | null | undefined): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

export function buildMessageBody(target: Pick<MessageTarget, "issueIdentifier" | "fallbackLabel">): string {
  if (isSafeIdentifier(target.issueIdentifier)) return `${MESSAGE_PREFIX}: ${target.issueIdentifier}`;
  if (target.fallbackLabel && FALLBACK_LABELS.has(target.fallbackLabel)) return `${MESSAGE_PREFIX}: ${target.fallbackLabel}`;
  return MESSAGE_PREFIX;
}

/**
 * ntfy title: `Paperclip decision <ID>` for a safe canonical identifier,
 * otherwise exactly `Paperclip decision`. The fallback label is never used.
 */
export function buildMessageTitle(target: Pick<MessageTarget, "issueIdentifier">): string {
  if (isSafeIdentifier(target.issueIdentifier)) return `${TITLE_PREFIX} ${target.issueIdentifier}`;
  return TITLE_PREFIX;
}

/**
 * Click link. A board decision opens the decision queue on that decision.
 * Otherwise uses `<base>/<PREFIX>/issues/<IDENTIFIER>` when possible, then
 * falls back to the issue UUID, the approval page, and finally the base URL.
 */
export function buildClickUrl(paperclipBaseUrl: string, target: MessageTarget): string {
  const base = paperclipBaseUrl.replace(/\/+$/, "");
  const prefix = target.issuePrefix && PREFIX_PATTERN.test(target.issuePrefix) ? target.issuePrefix : null;
  const scoped = (path: string) => (prefix ? `${base}/${prefix}/${path}` : `${base}/${path}`);
  if (target.decisionId && UUID_PATTERN.test(target.decisionId)) return scoped(`decisions?decisionId=${target.decisionId}`);
  if (isSafeIdentifier(target.issueIdentifier)) return scoped(`issues/${target.issueIdentifier}`);
  if (target.issueId && UUID_PATTERN.test(target.issueId)) return scoped(`issues/${target.issueId}`);
  if (target.approvalId && UUID_PATTERN.test(target.approvalId)) return scoped(`approvals/${target.approvalId}`);
  return base;
}

export function buildPublishUrl(ntfyBaseUrl: string, topic: string): string {
  return `${ntfyBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
}
