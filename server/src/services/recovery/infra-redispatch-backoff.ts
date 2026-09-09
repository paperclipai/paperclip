import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import { keyValueRow, runLinkRow, systemNoticePresentation, type NoticeMetadataRow } from "./notice-format.js";

// Startup recovery re-dispatches every issue that is still sitting in an active
// status, and it does so unconditionally. When the host itself is the thing
// killing runs, that turns into a loop: host restart -> reap in-flight runs ->
// instantly re-dispatch the same issues -> next restart kills them again. One
// issue was observed going round this loop eight times in twelve hours without
// producing a single commit.
//
// The retry counters that already exist do not close this, because each startup
// dispatch creates a *fresh* run and the per-run counters start at zero. The
// back-off below is therefore keyed on the issue's recent run history rather
// than on any single run, using the shared infra predicate from
// heartbeat-stop-metadata.ts to decide what counts as an infra kill.

// How many consecutive infra-caused terminations an issue may accumulate before
// startup re-dispatch stops firing immediately. Two is deliberate: one infra
// kill is noise and must not delay recovery at all, but by the second one in a
// row the host is the problem and an instant third dispatch just feeds the loop.
// Floored at 1 so a misconfigured 0 cannot disable automatic recovery entirely.
export const INFRA_REDISPATCH_BACKOFF_THRESHOLD = Math.max(
  1,
  Number(process.env.INFRA_REDISPATCH_BACKOFF_THRESHOLD) || 2,
);

// Cooldown applied to the first deferred dispatch, doubling for each additional
// consecutive infra kill. 30 minutes is longer than a reboot and shorter than a
// working session, so a genuinely transient restart costs one cooldown while a
// host that is flapping stops burning a dispatch every few minutes.
export const INFRA_REDISPATCH_BACKOFF_BASE_MS = Math.max(
  60_000,
  Number(process.env.INFRA_REDISPATCH_BACKOFF_BASE_MS) || 30 * 60_000,
);

// Ceiling on the doubling, so an issue is never held longer than a working day
// even after a long outage.
export const INFRA_REDISPATCH_BACKOFF_MAX_MS = Math.max(
  INFRA_REDISPATCH_BACKOFF_BASE_MS,
  Number(process.env.INFRA_REDISPATCH_BACKOFF_MAX_MS) || 6 * 60 * 60_000,
);

export const INFRA_REDISPATCH_BACKOFF_NOTICE_TITLE = "Paused on platform instability";

export type InfraRedispatchBackoffPolicy = {
  threshold?: number;
  baseMs?: number;
  maxMs?: number;
};

/**
 * Cooldown for the Nth consecutive infra-caused termination, measured from the
 * moment that run finished. Exponential from the base, capped at the maximum.
 */
export function infraRedispatchBackoffMs(
  consecutive: number,
  policy: InfraRedispatchBackoffPolicy = {},
): number {
  const threshold = policy.threshold ?? INFRA_REDISPATCH_BACKOFF_THRESHOLD;
  const baseMs = policy.baseMs ?? INFRA_REDISPATCH_BACKOFF_BASE_MS;
  const maxMs = policy.maxMs ?? INFRA_REDISPATCH_BACKOFF_MAX_MS;
  const overshoot = Math.max(0, consecutive - threshold);
  return Math.min(maxMs, baseMs * Math.pow(2, overshoot));
}

export type InfraRedispatchBackoffDecision =
  | { kind: "dispatch" }
  | {
      kind: "defer";
      consecutive: number;
      cooldownMs: number;
      retryAt: Date;
    };

/**
 * Decide whether recovery may re-dispatch an issue whose most recent runs were
 * all killed by infrastructure.
 *
 * Below the threshold this always returns `dispatch`, so ordinary recovery is
 * untouched. At or above it, dispatch is deferred until the cooldown measured
 * from the most recent infra kill has elapsed — so recovery resumes on its own
 * with no manual unpark, and the back-off disappears entirely as soon as one run
 * reaches a normal terminal state (the caller stops counting at that run).
 */
export function evaluateInfraRedispatchBackoff(input: {
  consecutive: number;
  latestFinishedAt: Date | null;
  now: Date;
  policy?: InfraRedispatchBackoffPolicy;
}): InfraRedispatchBackoffDecision {
  const threshold = input.policy?.threshold ?? INFRA_REDISPATCH_BACKOFF_THRESHOLD;
  if (input.consecutive < threshold) return { kind: "dispatch" };

  // Without a finish timestamp we cannot tell how long the issue has been
  // waiting, so dispatch rather than park it indefinitely.
  if (!input.latestFinishedAt) return { kind: "dispatch" };

  const cooldownMs = infraRedispatchBackoffMs(input.consecutive, input.policy);
  const retryAt = new Date(input.latestFinishedAt.getTime() + cooldownMs);
  if (input.now.getTime() >= retryAt.getTime()) return { kind: "dispatch" };

  return { kind: "defer", consecutive: input.consecutive, cooldownMs, retryAt };
}

export type InfraRedispatchBackoffNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

export function formatInfraBackoffDuration(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/**
 * The notice that makes the hold legible: the issue has to read as "the platform
 * kept killing this", not as a stuck or failing agent, and it has to say that no
 * manual action is required.
 */
export function buildInfraRedispatchBackoffNotice(input: {
  consecutive: number;
  cooldownMs: number;
  retryAt: Date;
  latestRun: { id: string; status: string; agentId?: string | null; errorCode?: string | null } | null;
}): InfraRedispatchBackoffNotice {
  const cooldown = formatInfraBackoffDuration(input.cooldownMs);
  const rows: NoticeMetadataRow[] = [
    keyValueRow("Consecutive infra-caused terminations", input.consecutive),
    keyValueRow("Cooldown", cooldown),
    keyValueRow("Next automatic attempt", input.retryAt.toISOString()),
  ];
  if (input.latestRun) {
    rows.push(runLinkRow("Last terminated run", input.latestRun));
    if (input.latestRun.errorCode) rows.push(keyValueRow("Termination code", input.latestRun.errorCode));
  }

  return {
    body:
      `The last ${input.consecutive} runs on this issue were terminated by the platform ` +
      "(server restart or lost process), not by the assigned agent. " +
      `Paperclip is holding off on re-dispatching for ${cooldown} rather than starting another run ` +
      "that would most likely be killed the same way. " +
      "This issue is not blocked and needs no manual action: recovery resumes automatically after the " +
      "cooldown, and the hold clears as soon as one run finishes normally.",
    presentation: systemNoticePresentation({
      tone: "warning",
      title: INFRA_REDISPATCH_BACKOFF_NOTICE_TITLE,
    }),
    metadata: {
      version: 1,
      sourceRunId: input.latestRun?.id ?? null,
      sections: [{ title: "Platform instability", rows }],
    },
  };
}
