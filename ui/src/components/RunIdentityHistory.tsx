import type { HeartbeatRun } from "@paperclipai/shared";
import type { CompanyUserDirectoryEntry } from "@/api/access";
import { useTranslation } from "@/i18n";

// Identity causes also include wake reasons from heartbeat dispatch. They are
// open strings in the API, so only recognized product values are translated.
const identityValues = {
  cause: new Set([
    "company_default", "dispatch", "instruction", "steering", "heartbeat_timer",
    "issue_assigned", "issue_checked_out", "issue_commented", "issue_comment_mentioned",
    "issue_reopened_via_comment", "issue_blockers_resolved", "issue_children_completed",
    "issue_status_changed", "issue_tree_restored", "issue_recovery_action_restored",
    "execution_review_requested", "execution_approval_requested", "execution_changes_requested",
    "approval_approved", "approval_rejected", "interaction_pending", "issue_unblock_requested",
    "task_watchdog_stopped_subtree", "plugin_issue_wakeup_requested", "provider_quota_recovery",
    "issue_disposition_repair", "issue_review_path_lost", "issue_monitor_recovery_issue",
    "issue_monitor_recovery", "issue_monitor_due", "missing_issue_comment", "process_lost_retry",
    "workspace_busy_retry", "interaction_continuation_infra_retry", "max_turns_continuation_retry",
    "execution_review_participant_recovery", "transient_failure_retry", "finish_successful_run_handoff",
    "issue_continuation_needed", "issue_assignment_recovery", "run_liveness_continuation", "source_scoped_recovery_action",
  ]),
  status: new Set(["accepted", "pending", "rejected"]),
  githubStatus: new Set(["available", "absent", "unavailable"]),
  source: new Set(["personal", "dedicated"]),
};

// Exact diagnostics emitted by github-operation-credentials / git-credentials.
// Unknown provider messages remain untouched instead of being guessed from prose.
const githubReasonKeys = new Map([
  ["No GitHub identity connected", "notConnected"],
  ["GitHub credentials are temporarily unavailable", "temporarilyUnavailable"],
  ["No managed GitHub identity is available for this run", "noMatchingIdentity"],
  ["More than one managed GitHub identity matches this run", "ambiguousIdentity"],
  ["The managed GitHub connection is unavailable", "connectionUnavailable"],
  ["The managed GitHub identity must be reconnected", "reconnectRequired"],
  ["The managed GitHub identity owner is not an authorized company member", "ownerUnauthorized"],
  ["The managed GitHub identity is incomplete", "identityIncomplete"],
  ["The managed GitHub identity no longer has repository access", "repositoryAccessLost"],
  ["The personal GitHub credential cannot be resolved", "personalCredentialUnresolved"],
  ["The personal GitHub credential is invalid", "personalCredentialInvalid"],
  ["The personal GitHub credential is missing", "personalCredentialMissing"],
]);

export function RunIdentityHistory({ history, users }: {
  history?: HeartbeatRun["identityHistory"] | null;
  users?: CompanyUserDirectoryEntry[];
}) {
  const { t } = useTranslation();
  if (!history?.length) return null;

  function displayValue(group: keyof typeof identityValues, value: string) {
    return identityValues[group].has(value)
      ? t(`runIdentityHistory.${group}.${value}`)
      : value;
  }

  function displayReason(reason: string) {
    const key = githubReasonKeys.get(reason);
    return key ? t(`runIdentityHistory.reason.${key}`) : reason;
  }

  return (
    <details className="text-xs text-muted-foreground" data-testid="run-identity-history">
      <summary className="cursor-pointer">{t("runIdentityHistory.title")}</summary>
      <ol className="mt-2 space-y-2">
        {history.map((identity) => {
          const person = users?.find((entry) => entry.principalId === identity.responsibleUserId);
          return (
            <li key={identity.id}>
              <span className="text-foreground">
                {person?.user?.name ?? person?.user?.email ?? identity.responsibleUserId ?? t("runIdentityHistory.noResponsiblePerson")}
              </span>
              {" · "}{displayValue("cause", identity.cause)}{" · "}{displayValue("status", identity.status)}
              {identity.github ? (
                <span className="block">
                  {identity.github.login ? `@${identity.github.login} · ` : ""}
                  {identity.github.source ? <>{displayValue("source", identity.github.source)}{" · "}</> : null}
                  {displayValue("githubStatus", identity.github.status)}
                  {identity.github.reason ? <>: {displayReason(identity.github.reason)}</> : null}
                </span>
              ) : <span className="block">{t("runIdentityHistory.noOperation")}</span>}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
