import type { FeedbackSource } from "./constants.js";

type NormalizedFeedback = {
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  sourceRef?: string;
};

export const FEEDBACK_STATE_KEY = "last-feedback-ingest";

export const FEEDBACK_PRIORITIES = new Set([
  "critical",
  "high",
  "medium",
  "low",
]);

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePriority(value: unknown): "critical" | "high" | "medium" | "low" {
  const raw = asString(value)?.toLowerCase();
  if (!raw) return "medium";
  if (raw.includes("blocker") || raw.includes("critical")) return "critical";
  if (raw.includes("high")) return "high";
  if (raw.includes("low") || raw.includes("minor") || raw.includes("trivial")) return "low";
  return "medium";
}

function pickJira(payload: Record<string, unknown>): NormalizedFeedback {
  const fields = asObject(payload.fields);
  const priority = asObject(fields.priority);
  const issueKey = asString(payload.key);
  const title = asString(fields.summary) ?? `Jira feedback ${issueKey ?? "(no-key)"}`;
  const description = asString(fields.description) ?? asString(payload.description) ?? "No description provided.";
  const sourceRef = issueKey ?? asString(payload.id);
  return {
    title,
    description,
    sourceRef,
    priority: normalizePriority(asString(priority.name) ?? asString(fields.priority)),
  };
}

function pickBitbucket(payload: Record<string, unknown>): NormalizedFeedback {
  const pullrequest = asObject(payload.pullrequest);
  const comment = asObject(payload.comment);
  const actor = asObject(payload.actor);
  const links = asObject(pullrequest.links);
  const html = asObject(links.html);

  const prTitle = asString(pullrequest.title);
  const commentBody = asString(asObject(comment.content).raw) ?? asString(comment.content);
  const actorName = asString(actor.display_name) ?? asString(actor.nickname);

  const title = prTitle
    ? `Bitbucket PR feedback: ${prTitle}`
    : "Bitbucket feedback";
  const description = commentBody
    ? `${commentBody}${actorName ? `\n\nFrom: ${actorName}` : ""}`
    : "Bitbucket event received without comment payload.";

  return {
    title,
    description,
    sourceRef: asString(html.href) ?? asString(pullrequest.id),
    priority: "medium",
  };
}

function pickSlack(payload: Record<string, unknown>): NormalizedFeedback {
  const event = asObject(payload.event);
  const text = asString(event.text) ?? asString(payload.text) ?? "Slack message payload received.";
  const channel = asString(event.channel) ?? asString(payload.channel);
  const user = asString(event.user) ?? asString(payload.user);
  const permalink = asString(payload.permalink);

  return {
    title: `Slack feedback${channel ? ` (${channel})` : ""}`,
    description: `${text}${user ? `\n\nFrom: ${user}` : ""}`,
    sourceRef: permalink ?? asString(event.ts),
    priority: "medium",
  };
}

export function normalizeFeedbackPayload(
  source: FeedbackSource,
  payload: Record<string, unknown>,
): NormalizedFeedback {
  if (source === "jira") return pickJira(payload);
  if (source === "bitbucket") return pickBitbucket(payload);
  return pickSlack(payload);
}
