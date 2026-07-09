import type { PipelineCaseLiveness } from "@paperclipai/shared";

/**
 * Visual tone for a pipeline item liveness banner. Each tone maps to a palette
 * in {@link ../components/PipelineLivenessBanner}:
 * - `blocked`    → amber, "automation paused, waiting on a named blocker"
 * - `permission` → purple, "a permission grant is missing before this can run"
 * - `retry`      → indigo, "blocker resolved, ready to retry"
 * - `attention`  → orange, "automation failed / no action path, needs a nudge"
 */
export type LivenessBannerTone = "blocked" | "permission" | "retry" | "attention";

export type LivenessRetryKind = "automation" | "stage" | null;

export interface LivenessBannerLink {
  /** Task link target. We only link tasks; cases lack a routable id here. */
  issueId: string;
  identifier?: string | null;
  title?: string | null;
}

export interface LivenessBannerView {
  reason: PipelineCaseLiveness["reason"];
  tone: LivenessBannerTone;
  title: string;
  body: string;
  /** Primary link to the underlying blocker task, when one is known. */
  blockerLink: LivenessBannerLink | null;
  /** Secondary link to the linked automation/work task, when one is known. */
  automationLink: LivenessBannerLink | null;
  /** Permission key the configured responsible is missing (e.g. `pipelines:write`). */
  permissionKey: string | null;
  /** Whether a retry call-to-action should render. */
  showRetry: boolean;
  /** Which mutation the retry CTA should invoke. */
  retryKind: LivenessRetryKind;
  retryLabel: string;
  /** Reassurance line that steers operators away from forcing a manual move. */
  helperNote: string | null;
}

const AUTO_RETRY_NOTE =
  "Paperclip retries automatically once the blocker clears — you don't need to move the item by hand.";

/**
 * Prosumer-voice body for the `no_action_path` "stuck" banner. The server's
 * raw `liveness.message` ("No lease, linked work, blocker, automation retry,
 * review, or breakdown action path is visible.") leaks implementation vocabulary
 * the PAP-11245 voice rule forbids, so we translate it here. See PAP-11259.
 */
const NO_ACTION_PATH_BODY =
  "Paperclip can't see anything to work on next here — no automation, retry, blocker, or review. " +
  "Re-run the stage to nudge it, or use the ⋯ menu to move it by hand.";

/**
 * The `pipelines:write` permission key is the only permission the Phase 2
 * preflight blocks on today. The fingerprint encodes it as the final two
 * colon-separated segments (`...:pipelines:write`).
 */
function permissionKeyFromFingerprint(fingerprint: string | null | undefined): string | null {
  if (!fingerprint) return null;
  const parts = fingerprint.split(":");
  if (parts.length < 2) return null;
  const key = parts.slice(parts.length - 2).join(":");
  return key.includes(":") ? key : null;
}

function blockerLinkFromLiveness(liveness: PipelineCaseLiveness): LivenessBannerLink | null {
  const blocker = liveness.blocker;
  if (blocker?.issueId) {
    return { issueId: blocker.issueId, title: blocker.title ?? null };
  }
  return null;
}

function automationLinkFromLiveness(liveness: PipelineCaseLiveness): LivenessBannerLink | null {
  const issue = liveness.issue;
  if (issue?.id) {
    return { issueId: issue.id, identifier: issue.identifier, title: issue.title };
  }
  return null;
}

/**
 * Derive the banner view-model from the server's liveness payload. Returns
 * `null` for states that should not raise a banner (terminal, actively running,
 * or states already represented by another section such as review/children
 * waiting). This keeps the item detail header from over-crowding.
 */
export function derivePipelineLivenessBanner(
  liveness: PipelineCaseLiveness | null | undefined,
): LivenessBannerView | null {
  if (!liveness) return null;

  switch (liveness.reason) {
    // Handled elsewhere or not "stuck" — no banner.
    case "terminal":
    case "lease_active":
    case "linked_issue_active":
    case "linked_issue_waiting":
    case "children_waiting":
    case "review_waiting":
      return null;

    case "case_blocked":
      return {
        reason: liveness.reason,
        tone: "blocked",
        title: "Automation paused — waiting on a blocker",
        body: liveness.message,
        blockerLink: blockerLinkFromLiveness(liveness),
        automationLink: automationLinkFromLiveness(liveness),
        permissionKey: null,
        showRetry: false,
        retryKind: null,
        retryLabel: "",
        helperNote: AUTO_RETRY_NOTE,
      };

    case "linked_issue_blocked":
      return {
        reason: liveness.reason,
        tone: "blocked",
        title: "Automation paused — waiting on a blocker",
        body: liveness.message,
        blockerLink: blockerLinkFromLiveness(liveness),
        automationLink: automationLinkFromLiveness(liveness),
        permissionKey: null,
        showRetry: false,
        retryKind: null,
        retryLabel: "",
        helperNote: AUTO_RETRY_NOTE,
      };

    case "permission_preflight_failed":
      return {
        reason: liveness.reason,
        tone: "permission",
        title: "Permission needed before this can run",
        body: liveness.message,
        blockerLink: null,
        automationLink: automationLinkFromLiveness(liveness),
        permissionKey: permissionKeyFromFingerprint(liveness.automation?.fingerprint) ?? "pipelines:write",
        showRetry: false,
        retryKind: null,
        retryLabel: "",
        helperNote:
          "Grant the access above to the configured responsible, then Paperclip retries automatically.",
      };

    case "automation_failed": {
      // Phase 2 reuses `automation_failed` both for a generic failure and for
      // the recovered "permission restored" case. The recovery path is the only
      // one whose message announces the restore, so key off that.
      const recovered = /permission has been restored/i.test(liveness.message);
      const automationId = liveness.automation?.automationId ?? null;
      return {
        reason: liveness.reason,
        tone: recovered ? "retry" : "attention",
        title: recovered ? "Blocker resolved — ready to retry" : "Automation failed",
        body: liveness.message,
        blockerLink: null,
        automationLink: automationLinkFromLiveness(liveness),
        permissionKey: null,
        showRetry: true,
        retryKind: automationId ? "automation" : "stage",
        retryLabel: "Retry now",
        helperNote: recovered ? AUTO_RETRY_NOTE : null,
      };
    }

    case "breakdown_pending":
      return {
        reason: liveness.reason,
        tone: "attention",
        title: "Waiting on breakdown evidence",
        body: liveness.message,
        blockerLink: null,
        automationLink: null,
        permissionKey: null,
        showRetry: true,
        retryKind: "stage",
        retryLabel: "Re-run stage automation",
        helperNote: null,
      };

    case "breakdown_incomplete":
      return {
        reason: liveness.reason,
        tone: "blocked",
        title: "Breakdown is incomplete",
        body: missingPiecesBody(liveness),
        blockerLink: null,
        automationLink: null,
        permissionKey: null,
        showRetry: true,
        retryKind: "stage",
        retryLabel: "Re-run stage automation",
        helperNote: null,
      };

    case "no_action_path":
      return {
        reason: liveness.reason,
        tone: "attention",
        title: "This item is stuck",
        body: NO_ACTION_PATH_BODY,
        blockerLink: null,
        automationLink: null,
        permissionKey: null,
        showRetry: true,
        retryKind: "stage",
        retryLabel: "Re-run stage automation",
        helperNote: null,
      };

    default:
      return null;
  }
}

function missingPiecesBody(liveness: PipelineCaseLiveness): string {
  const missing = liveness.breakdown?.missingRequestKeys?.length ?? 0;
  if (missing > 0) {
    return `${liveness.message} ${missing} expected ${missing === 1 ? "piece is" : "pieces are"} still missing.`;
  }
  return liveness.message;
}

/** True when the PAP-11238 "Re-run stage automation" menu item must be disabled. */
export function shouldDisableRerunForPermission(
  liveness: PipelineCaseLiveness | null | undefined,
): boolean {
  return liveness?.reason === "permission_preflight_failed";
}
