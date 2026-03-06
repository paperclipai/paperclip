export type IssueWakeKind = "assignment" | "mention";

export interface IssueWakePayload {
  kind: IssueWakeKind;
  issueId: string | null;
  issueIdentifier: string | null;
  deepLink: string | null;
}

type NotificationData = Record<string, unknown>;

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toWakeKind(value: unknown): IssueWakeKind | null {
  if (value === "issue_assignment" || value === "assignment") {
    return "assignment";
  }
  if (value === "issue_mention" || value === "mention") {
    return "mention";
  }
  return null;
}

export function parseIssueWakePayload(data: NotificationData): IssueWakePayload | null {
  const kind =
    toWakeKind(data.eventType) ??
    toWakeKind(data.type) ??
    toWakeKind(data.reason);
  if (!kind) {
    return null;
  }

  return {
    kind,
    issueId: toTrimmedString(data.issueId),
    issueIdentifier: toTrimmedString(data.issueIdentifier),
    deepLink: toTrimmedString(data.deepLink) ?? toTrimmedString(data.url),
  };
}

export function extractIssueIdFromDeepLink(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const queryMatch = trimmed.match(/[?&]issueId=([^&]+)/i);
  if (queryMatch?.[1]) {
    return decodeURIComponent(queryMatch[1]);
  }

  const issuePathMatch = trimmed.match(/\/issue\/([^/?#]+)/i);
  if (issuePathMatch?.[1]) {
    return decodeURIComponent(issuePathMatch[1]);
  }

  return null;
}
