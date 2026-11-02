/**
 * Plain-language copy for a *failed* issue-thread interaction resolution
 * (PAP-17287).
 *
 * The resolution routes deny with a specific reason — human-only, creator
 * excluded, addressee mismatch, a governed action, an already-resolved card.
 * Collapsing all of that to `Try again` tells an operator to repeat an action
 * that will never succeed, so this module keeps the server's explanation and,
 * for an audience denial, follows it with who *can* respond.
 *
 * Presentation only. Authority is the server's: nothing here decides whether an
 * action is permitted, it only explains the answer the server already gave.
 */

import { t } from "@/i18n";
import type { InteractionAudienceDescription } from "./interaction-audience";

/**
 * Denials that mean "you are outside this card's resolver audience". Mirrors the
 * codes the server's audience evaluator can return
 * (`server/src/services/issue-thread-interaction-resolution.ts`), plus the
 * scope denial raised before it.
 */
export const INTERACTION_AUDIENCE_DENIAL_CODES = [
  "interaction_human_only",
  "interaction_creator_excluded",
  "interaction_addressee_mismatch",
  "interaction_governed_action_denied",
  "interaction_run_attribution_required",
  "interaction_scope_denied",
] as const;

/**
 * Denials that are permanent for a different reason: the card moved on. Retrying
 * cannot help, so these lose the retry prompt too.
 */
const INTERACTION_SETTLED_CODES = [
  "interaction_not_found",
  "interaction_already_resolved",
  "interaction_superseded",
  "interaction_stale_target",
  "interaction_issue_closed",
] as const;

export type InteractionResolutionFailureKind = "audience_denied" | "settled" | "transient";

export interface InteractionResolutionFailure {
  kind: InteractionResolutionFailureKind;
  /** Copy for the inline error region. Never invites a retry that cannot work. */
  message: string;
  /** Server-provided denial code, when the response carried one. */
  code: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The server's `code`, from either the top-level field or the details object. */
export function interactionResolutionErrorCode(error: unknown): string | null {
  const body = record(record(error)?.body);
  if (!body) return null;
  if (typeof body.code === "string" && body.code) return body.code;
  const details = record(body.details);
  return typeof details?.code === "string" && details.code ? details.code : null;
}

function errorStatus(error: unknown): number | null {
  const status = record(error)?.status;
  return typeof status === "number" ? status : null;
}

/** The server's human-readable reason, preserved verbatim apart from punctuation. */
function serverReason(error: unknown): string | null {
  const body = record(record(error)?.body);
  const fromBody = typeof body?.error === "string" ? body.error.trim() : "";
  const fromError = error instanceof Error ? error.message.trim() : "";
  const reason = fromBody || fromError;
  if (!reason) return null;
  // The API writes reasons as bare clauses ("This interaction is human-only").
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

export function isInteractionAudienceDenial(error: unknown): boolean {
  const code = interactionResolutionErrorCode(error);
  if (code) return (INTERACTION_AUDIENCE_DENIAL_CODES as readonly string[]).includes(code);
  // A 403 with no code is still an authorization refusal, not a hiccup.
  return errorStatus(error) === 403;
}

/** The audience of the card being resolved, as far as this client knows it. */
export type InteractionResolutionAudience = Pick<
  InteractionAudienceDescription,
  "shortSummary" | "isOpen"
>;

/**
 * Classify a rejected resolution and produce the copy to show inline.
 *
 * `audience` is the effective audience of the card being resolved; when the
 * failure is an audience denial *and* that audience is narrower than the open
 * default, its short form is appended so the reader learns who can respond
 * instead of being told to retry.
 */
export function describeInteractionResolutionFailure(
  error: unknown,
  audience?: InteractionResolutionAudience | null,
): InteractionResolutionFailure {
  const code = interactionResolutionErrorCode(error);
  const reason = serverReason(error);

  if (isInteractionAudienceDenial(error)) {
    // Only a *narrowed* audience has a responder worth naming. Appending the
    // open-default clause to a refusal produces copy that refutes itself —
    // "You are not in this card's resolver audience. Anyone can respond." —
    // which happens whenever the snapshot the client holds is wider than the
    // policy the server just enforced (PAP-17289).
    const responder = audience && !audience.isOpen && audience.shortSummary
      ? `${audience.shortSummary}.`
      : null;
    // Without a code the server has told us only that this is forbidden, not
    // *why*. Restate the status; do not invent a resolver-audience cause it
    // never claimed.
    const coded = code !== null
      && (INTERACTION_AUDIENCE_DENIAL_CODES as readonly string[]).includes(code);
    return {
      kind: "audience_denied",
      code,
      message: [
        reason
          ?? (coded
            ? "You are not in this card's resolver audience."
            : "You do not have permission to respond to this card."),
        responder,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  if (code && (INTERACTION_SETTLED_CODES as readonly string[]).includes(code)) {
    return {
      kind: "settled",
      code,
      message: reason ?? "This request is no longer waiting for a decision.",
    };
  }

  return {
    kind: "transient",
    code,
    message: reason ? `${reason} Try again.` : "Couldn't submit. Try again.",
  };
}

/** Convenience for the many call sites that only need the sentence. */
export function interactionResolutionErrorMessage(
  error: unknown,
  audience?: InteractionResolutionAudience | null,
): string {
  return describeInteractionResolutionFailure(error, audience).message;
}

/** Exact built-in server reasons only; unfamiliar server details stay intact. */
const RESOLUTION_REASON_DISPLAY_KEYS: Readonly<Record<string, string>> = {
  "Only the addressed user may resolve this issue-thread interaction.": "localizationInteractionAudience.reasonUserAddressed",
  "This issue-thread interaction requires a resolver other than its creator.": "localizationInteractionAudience.reasonOtherCreator",
  "A valid authenticated agent run is required to resolve this issue-thread interaction.": "localizationInteractionAudience.reasonRunRequired",
  "This interaction is bound to a governed action that requires independent authorization.": "localizationInteractionAudience.reasonGoverned",
  "This issue-thread interaction is human-only.": "localizationInteractionAudience.reasonHumanOnly",
  "This issue-thread interaction is addressed to a specific user.": "localizationInteractionAudience.reasonSpecificUser",
  "Only the addressed agent or an authorized human may resolve this issue-thread interaction.": "localizationInteractionAudience.reasonAgentAddressed",
  "This issue-thread interaction requires a resolver other than its creator or creating run.": "localizationInteractionAudience.reasonOtherRun",
  "The authenticated agent run is not valid for this issue-thread interaction.": "localizationInteractionAudience.reasonInvalidRun",
  "This issue-thread interaction is outside the actor's trusted control-plane scope.": "localizationInteractionAudience.reasonTrustedScope",
  "This issue-thread interaction is outside the current watchdog scope.": "localizationInteractionAudience.reasonWatchdogScope",
  "This issue-thread interaction is outside the actor's authorized issue scope.": "localizationInteractionAudience.reasonIssueScope",
  "Suggested-task creation is outside the resolver's authorized issue scope.": "localizationInteractionAudience.reasonTaskIssueScope",
  "Suggested-task creation is outside the current watchdog scope.": "localizationInteractionAudience.reasonTaskWatchdogScope",
  "Suggested-task creation requires independent authorization for every selected task.": "localizationInteractionAudience.reasonTaskAuthorization",
  "Interaction not found.": "localizationInteractionAudience.reasonNotFound",
  "Interaction is no longer actionable because the issue is closed.": "localizationInteractionAudience.reasonClosed",
  "Interaction has already been resolved.": "localizationInteractionAudience.reasonResolved",
  "Interaction target is stale.": "localizationInteractionAudience.reasonStale",
  "Interaction has been superseded.": "localizationInteractionAudience.reasonSuperseded",
  "Forbidden.": "localizationInteractionAudience.reasonForbidden",
  "This interaction is human-only.": "localizationInteractionAudience.reasonHumanOnlyLegacy",
  "Review policy `not_creator` requires someone other than the writer who moved the issue into `in_review` to approve or reject it.": "localizationInteractionAudience.reasonReviewWriter",
  "Review policy `not_creator` requires a different writer, but the review requester could not be determined.": "localizationInteractionAudience.reasonReviewUnknown",
};

export function describeInteractionResolutionFailureDisplay(
  error: unknown,
  audience?: InteractionResolutionAudience | null,
): InteractionResolutionFailure {
  const raw = describeInteractionResolutionFailure(error);
  return {
    ...raw,
    get message() {
      const rawReason = serverReason(error);
      const reasonKey = rawReason ? RESOLUTION_REASON_DISPLAY_KEYS[rawReason] : undefined;
      const reason = reasonKey ? t(reasonKey) : rawReason;
      if (raw.kind === "audience_denied") {
        const coded = raw.code !== null && (INTERACTION_AUDIENCE_DENIAL_CODES as readonly string[]).includes(raw.code);
        const explanation = reason ?? t(coded
          ? "localizationInteractionAudience.errorOutsideAudience"
          : "localizationInteractionAudience.errorForbidden");
        return audience && !audience.isOpen && audience.shortSummary
          ? t("localizationInteractionAudience.errorWithAudience", { reason: explanation, audience: audience.shortSummary })
          : explanation;
      }
      if (raw.kind === "settled") return reason ?? t("localizationInteractionAudience.errorSettled");
      return reason
        ? t("localizationInteractionAudience.errorRetryReason", { reason })
        : t("localizationInteractionAudience.errorRetry");
    },
  };
}

export function interactionResolutionErrorMessageDisplay(
  error: unknown,
  audience?: InteractionResolutionAudience | null,
): string {
  return describeInteractionResolutionFailureDisplay(error, audience).message;
}

/**
 * UI-only error envelope. Keep the original cause and audience facts across
 * form state updates; do not freeze a translated string in React state.
 */
export class InteractionResolutionDisplayError extends Error {
  constructor(
    readonly resolutionCause: unknown,
    readonly audience?: InteractionResolutionAudience | null,
  ) {
    super(describeInteractionResolutionFailure(resolutionCause).message);
    this.name = "InteractionResolutionDisplayError";
  }

  get displayMessage(): string {
    return interactionResolutionErrorMessageDisplay(this.resolutionCause, this.audience);
  }
}
