import type { IssueCommentPresentation } from "@paperclipai/shared";
import type { SystemNoticeTone } from "../components/SystemNotice";

/**
 * Pure classifier for system comments in the chat shell (PAP-443 / PAP-442
 * Phase 1): derive a short plain-English one-liner + tone for the collapsed
 * row. Server-authored presentation hints win when present; otherwise the
 * known recovery families are pattern-matched from the comment body. Nothing
 * here suppresses data — the full body stays available behind the expand.
 */
export interface HumanizedSystemNotice {
  title: string;
  tone: SystemNoticeTone;
  /** Optional muted trailing snippet for the generic fallback row. */
  detail?: string;
}

const FALLBACK_TITLE = "System update";
const DETAIL_MAX_CHARS = 80;

/** Failure code the recovery comments embed as "Latest retry failure: `code`". */
function retryFailureCode(body: string): string | null {
  const match = body.match(/Latest retry failure: `([^`]+)`/);
  return match ? match[1] : null;
}

/** Owner display name from a "Recovery owner: [Name](/…/agents/…)" markdown link. */
function recoveryOwnerName(body: string): string | null {
  const match = body.match(/Recovery owner: \[([^\]]+)\]\(/);
  const name = match?.[1]?.trim();
  return name && name.length > 0 ? name : null;
}

function firstSentence(body: string): string | undefined {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const sentenceEnd = firstLine.search(/[.!?](\s|$)/);
  const sentence = sentenceEnd >= 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  if (sentence.length <= DETAIL_MAX_CHARS) return sentence;
  return `${sentence.slice(0, DETAIL_MAX_CHARS - 1).trimEnd()}…`;
}

export function humanizeSystemNotice(input: {
  body: string;
  presentation?: IssueCommentPresentation | null;
}): HumanizedSystemNotice {
  const presentationTitle = input.presentation?.title?.trim();
  const presentationTone = input.presentation?.tone;
  if (presentationTitle) {
    return { title: presentationTitle, tone: presentationTone ?? "neutral" };
  }

  const body = input.body ?? "";
  const code = retryFailureCode(body);

  if (code === "claude_auth_required") {
    return {
      title: "Task paused — Claude needs re-authentication",
      tone: presentationTone ?? "warning",
    };
  }
  if (code === "configuration_incomplete" || body.includes("secret/env bindings are missing")) {
    return {
      title: "Task paused — a secret/config binding is missing",
      tone: presentationTone ?? "warning",
    };
  }
  if (code === "workspace_validation_failed" || body.includes("workspace failed validation")) {
    return {
      title: "Task paused — workspace problem",
      tone: presentationTone ?? "warning",
    };
  }
  if (body.includes("no live execution path")) {
    const owner = recoveryOwnerName(body);
    return {
      title: owner
        ? `Task paused — waiting on ${owner}`
        : "Task paused — waiting on a recovery owner",
      tone: presentationTone ?? "warning",
    };
  }

  return {
    title: FALLBACK_TITLE,
    tone: presentationTone ?? "neutral",
    detail: firstSentence(body),
  };
}
