import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import { ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE } from "../environment-provider-unavailable-error.js";
import {
  agentLinkRow,
  keyValueRow,
  runLinkRow,
  systemNoticePresentation,
  type NoticeMetadataRow,
  type NoticeMetadataSection,
} from "./notice-format.js";

/** The saved version is unchanged by a failed restore; the run names the failed step. */
export const REMOTE_WORKSPACE_RESTORE_NEXT_ACTION =
  "The saved work could not be put back into the sandbox, so no agent work started. The saved version was kept. "
  + "Press Retry to start again from it.";

export const RETRY_FROM_SAVED_WORK_NEXT_ACTION =
  "This attempt could not be finished. Press Retry to start it again from the saved work.";

// Short human-readable body plus the presentation header for one recovery
// family. The escalation path merges in the metadata rows only it knows
// (recovery action, owner, source run) via buildStrandedRecoveryEscalationNotice.
export type StrandedRecoveryNoticeSeed = {
  body: string;
  title: string;
  tone: IssueCommentPresentation["tone"];
  nextAction?: string;
};

export type StrandedRecoveryEscalationNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

export const DEFAULT_STRANDED_RECOVERY_NOTICE_BODY =
  "This attempt could not be finished automatically. Press Retry to start it again from the saved work.";

const DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE = "Automatic recovery blocked";

const STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE: Record<string, string> = {
  workspace_validation_failed: "Workspace validation failed",
  configuration_incomplete: "Configuration incomplete",
  execution_review_participant_recovery: "Review recovery stalled",
};

// Titles keyed by the source run's classified error code. The raw failure text
// never reaches the issue thread (summarizeRunFailureForIssueComment withholds
// it), so the classified code is the only safe, specific cause the collapsed
// notice row can lead with. A mapped code outranks the seed titles because the
// seeds describe the recovery family ("No live execution path"), not the cause.
const STRANDED_RECOVERY_NOTICE_TITLES_BY_RUN_ERROR_CODE: Record<string, string> = {
  provider_quota: "Error: usage limit reached",
  claude_auth_required: "Error: not logged in to Claude",
  acpx_auth_required: "Error: agent login required",
};

export const RATE_LIMIT_WINDOW_NOTICE_TITLE = "Error: model rate limit reached";
const TEMPORARY_SETUP_NEXT_ACTION = "Setting up the workspace took too long, so no agent work started. "
  + "Paperclip tries again automatically.";

const AUTOMATIC_RETRY_SENTENCE = "Paperclip tries again automatically.";
const MANUAL_RETRY_SENTENCE = "Press Retry to start it again.";

const TEMPORARY_SETUP_CODES = new Set(["remote_workspace_prepare_timeout", "reusable_sandbox_resume_failed"]);

const WORKSPACE_SCAN_NOTICES: Record<string, { title: string; nextAction: string }> = {
  workspace_git_scan_timeout: { title: "Workspace scan timed out", nextAction: "Reading the task's files took too long, so no agent work started. Press Retry to start it again." },
  remote_workspace_prepare_timeout: { title: "Workspace setup timed out", nextAction: TEMPORARY_SETUP_NEXT_ACTION },
  remote_workspace_restore_failed: { title: "Saved workspace could not be restored", nextAction: REMOTE_WORKSPACE_RESTORE_NEXT_ACTION },
  plugin_worker_unavailable: { title: "Environment plugin was not running", nextAction: "The plugin that starts this agent's sandbox was not running, so no agent work started. Press Retry once it is running again." },
  environment_provider_unavailable: { title: "Environment provider was temporarily unavailable", nextAction: "Paperclip retried automatically before the agent started, but the provider was still unavailable. No agent work started. Retry the task once the provider is available." },
  reusable_sandbox_resume_failed: { title: "Saved sandbox could not be resumed", nextAction: "The sandbox service did not start the saved sandbox in time. "
    + "The saved sandbox and its files were kept, and no agent work started. Paperclip tries again automatically." },
  workspace_git_scan_saturated: { title: "Workspace scan queue is full", nextAction: "The server was too busy to read the task's files, so no agent work started. Press Retry to start it again." },
  workspace_git_scan_output_limit: { title: "Workspace scan exceeded its limit", nextAction: "The task's files are larger than Paperclip can read at once, so no agent work started. Press Retry to start it again." },
  workspace_git_scan_failed: { title: "Workspace scan failed", nextAction: "The task's files could not be read, so no agent work started. Press Retry to start it again." },
  workspace_git_scan_cancelled: { title: "Workspace scan was cancelled", nextAction: "Preparing the task's files was stopped, so no agent work started. Press Retry to start it again." },
};

const SETUP_FAILURE_NOTICES: Record<string, StrandedRecoveryNoticeSeed> = {
  runner_revision_mismatch: {
    title: "Remote Runner is out of date",
    body: "The remote Runner does not match this Paperclip version, which is expected for a few minutes while a release updates the Runner. "
      + "Paperclip retried before the agent started, but the Runner was still not updated.",
    nextAction: "Check that the remote Runner received the update for this release, then retry the task.",
    tone: "danger",
  },
};

export function buildImmediateExecutionPathRecoveryNoticeSeed(input: {
  status: "todo" | "in_progress";
}): StrandedRecoveryNoticeSeed {
  const retryDescription = input.status === "todo"
    ? "Paperclip automatically retried dispatch for this assigned `todo` issue during terminal run recovery"
    : "Paperclip automatically retried continuation for this assigned `in_progress` issue during terminal run recovery";
  return {
    body:
      `${retryDescription}, but it still has no live execution path. ` +
      "Moving it to `blocked` so it is visible for intervention.",
    title: "No live execution path",
    tone: "danger",
  };
}

export function buildWorkspaceValidationRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "The task's workspace could not be used, so the agent did not start. " +
      "Press Retry to start it again.",
    title: "Workspace validation failed",
    tone: "danger",
  };
}

export const SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON = "sandbox_provider_plugin_not_ready";

function readNonEmptyStringField(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * What the operator must do to bring a sandbox provider plugin back to
 * `ready`, by the status the run observed. Enabling an `upgrade_pending`
 * plugin also approves the capabilities the upgrade added, so that case asks
 * for a review first.
 */
export function sandboxProviderPluginRemedy(pluginStatus: string): string {
  switch (pluginStatus) {
    case "upgrade_pending":
      return "review and approve the upgraded plugin's capabilities, then enable it (Plugins → Enable)";
    case "disabled":
      return "enable the plugin again (Plugins → Enable); an operator disabled it";
    default:
      return "enable the plugin (Plugins → Enable); a server restart also re-activates a bundled plugin";
  }
}

/**
 * Seed for a `configuration_incomplete` escalation. `configurationIncomplete`
 * is the structured payload the failed run recorded in `resultJson`; the body
 * names the specific gap for the reasons this notice knows, and falls back to
 * the secret/env-binding wording (the original and most common reason).
 */
export function buildConfigurationIncompleteRecoveryNoticeSeed(
  configurationIncomplete?: Record<string, unknown> | null,
): StrandedRecoveryNoticeSeed {
  if (readNonEmptyStringField(configurationIncomplete, "reason") === "workspace_base_ref_unresolved") {
    return {
      title: "Workspace base ref unavailable",
      body: "The agent did not start because the starting branch set for this task's workspace was not found in the repository.",
      nextAction: "Set a starting branch that exists in the repository, then press Retry.",
      tone: "danger",
    };
  }
  if (readNonEmptyStringField(configurationIncomplete, "reason") === "shared_realization_unsupported") {
    if (configurationIncomplete?.holderStale === true) {
      return {
        title: "Shared workspace still held",
        body: "Paperclip stopped before the agent started because another run still holds this task's shared workspace but has produced no output for more than an hour, and this execution environment cannot place concurrent agents in one physical shared folder.",
        nextAction: "Stop the other run on this task, or choose a separate workspace for this task, then press Retry.",
        tone: "danger",
      };
    }
    return {
      title: "Shared workspace unavailable",
      body: "Paperclip stopped before the agent started because this task allows concurrent agents in a shared workspace that another live run is using, and this execution environment cannot place concurrent agents in one physical shared folder.",
      nextAction: "Select an isolated task workspace, use a local or SSH environment, or change shared workspace concurrency from `allow` so the task waits for the other run.",
      tone: "danger",
    };
  }
  if (readNonEmptyStringField(configurationIncomplete, "reason") === "workspace_source_restricted") {
    return {
      title: "Task couldn’t start",
      body: "The task couldn’t start.",
      nextAction: "Retry the task.",
      tone: "danger",
    };
  }
  if (readNonEmptyStringField(configurationIncomplete, "reason") === "ai_connection_required") {
    if (readNonEmptyStringField(configurationIncomplete, "homeMode") === "preconfigured") {
      return {
        title: "Isolated Runner home required",
        body: "Paperclip stopped before the agent started because this agent runs in a plugin-provided environment, which requires a managed AI connection. A preconfigured Runner home does not use the agent's AI connection. The task is blocked until the agent uses an isolated Runner home.",
        nextAction: "Switch this agent to an isolated Runner home in Configuration, then retry the task.",
        tone: "danger",
      };
    }
    return {
      title: "AI connection required",
      body: "Paperclip stopped before the agent started because this agent runs in a plugin-provided environment, which requires a managed AI connection. The task is blocked until the agent has one.",
      nextAction: "Choose an AI connection for this agent in Configuration, then retry the task.",
      tone: "danger",
    };
  }
  if (readNonEmptyStringField(configurationIncomplete, "reason") === "ai_connection_unavailable") {
    return {
      title: "AI connection needs attention",
      body: "This task paused because its selected AI account is unavailable. Reconnect the account or choose an available connection to continue.",
      nextAction: "Reconnect the selected AI account or choose an available connection, then continue the task.",
      tone: "danger",
    };
  }
  if (readNonEmptyStringField(configurationIncomplete, "reason") === "ai_connection_incompatible") {
    return {
      title: "AI connection conflicts with project settings",
      body: "Paperclip stopped before the agent started because this agent's managed AI connection conflicts with authentication settings "
        + "in the project or the agent's arguments, such as an API key, token or apiKeyHelper. The task is blocked until the conflict is removed.",
      nextAction: "Remove the API key, token or apiKeyHelper from the project's Claude or Codex settings or the agent's arguments, "
        + "or choose a different AI connection for this agent, then retry the task.",
      tone: "danger",
    };
  }
  if (readNonEmptyStringField(configurationIncomplete, "reason") === SANDBOX_PROVIDER_PLUGIN_NOT_READY_REASON) {
    const pluginKey = readNonEmptyStringField(configurationIncomplete, "pluginKey") ?? "the sandbox provider plugin";
    const pluginStatus = readNonEmptyStringField(configurationIncomplete, "pluginStatus") ?? "not ready";
    return {
      body:
        `Paperclip stopped before dispatching the adapter because the sandbox provider plugin \`${pluginKey}\` ` +
        `is in status \`${pluginStatus}\` and cannot lease a sandbox. Runs will keep failing the same way until the ` +
        `plugin is \`ready\` again. Moving it to \`blocked\` so an operator can ${sandboxProviderPluginRemedy(pluginStatus)} ` +
        "before resuming.",
      title: "Configuration incomplete",
      tone: "danger",
    };
  }
  return {
    body:
      "The agent did not start because a secret it needs is not set. " +
      "Add the secret in the agent's settings, then press Retry.",
    title: "Configuration incomplete",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "The reviewer for this task did not finish the review, even after Paperclip asked again. " +
      "Choose a reviewer, or press Retry to ask the same reviewer again.",
    title: "Review recovery stalled",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantUnavailableNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "The reviewer for this task cannot take work right now, so the review could not continue. " +
      "Choose another reviewer, or press Retry once the reviewer is available.",
    title: "Review recovery stalled",
    tone: "danger",
  };
}

// Escalation dedupe matches the `Recovery action` key_value row via
// noticeMetadataReferencesRecoveryAction, so this builder must always emit
// that row with the raw action id.
export function buildStrandedRecoveryEscalationNotice(input: {
  seed?: StrandedRecoveryNoticeSeed | null;
  fallbackBody?: string | null;
  recoveryCause?: string | null;
  recoveryActionId: string;
  continuesAutomatically?: boolean;
  recoveryOwner: { id: string; name: string | null } | null | undefined;
  sourceRun: {
    id: string;
    agentId?: string | null;
    status: string;
    errorCode?: string | null;
    errorSummary?: string | null;
    rateLimitWindow?: boolean;
  } | null | undefined;
}): StrandedRecoveryEscalationNotice {
  const scanNotice = WORKSPACE_SCAN_NOTICES[input.sourceRun?.errorCode ?? ""];
  const retriesItself = TEMPORARY_SETUP_CODES.has(input.sourceRun?.errorCode ?? "") && input.continuesAutomatically === true;
  const workspaceScan = scanNotice && TEMPORARY_SETUP_CODES.has(input.sourceRun?.errorCode ?? "") && !retriesItself
    ? { ...scanNotice, nextAction: scanNotice.nextAction.replace(AUTOMATIC_RETRY_SENTENCE, MANUAL_RETRY_SENTENCE) }
    : scanNotice;
  const seed = workspaceScan ? {
    ...workspaceScan,
    body: retriesItself
      ? `Paperclip could not prepare the workspace before the agent started. ${workspaceScan.nextAction}`
      : `Paperclip could not prepare the workspace before the agent started. Automatic recovery could not continue. ${workspaceScan.nextAction}`,
    tone: "danger" as const,
  } : SETUP_FAILURE_NOTICES[input.sourceRun?.errorCode ?? ""] ?? input.seed;
  const fallbackBody = input.fallbackBody?.trim();
  const body = seed?.body ?? (fallbackBody || DEFAULT_STRANDED_RECOVERY_NOTICE_BODY);
  const title =
    (input.sourceRun?.rateLimitWindow ? RATE_LIMIT_WINDOW_NOTICE_TITLE : undefined) ??
    STRANDED_RECOVERY_NOTICE_TITLES_BY_RUN_ERROR_CODE[input.sourceRun?.errorCode?.trim() ?? ""] ??
    seed?.title ??
    STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE[input.recoveryCause ?? ""] ??
    DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE;

  const recoveryRows: NoticeMetadataRow[] = [
    keyValueRow("Recovery action", input.recoveryActionId),
    input.recoveryOwner
      ? agentLinkRow("Recovery owner", input.recoveryOwner)
      : keyValueRow(
          "Recovery owner",
          // A pre-dispatch provider outage needs no board decision, only Retry.
          input.recoveryCause === ENVIRONMENT_PROVIDER_UNAVAILABLE_CODE ? "Retry when ready" : "Waiting for you",
        ),
    keyValueRow(
      "Next action",
      seed?.nextAction ?? (input.recoveryOwner
        ? "The assigned agent continues the task from the saved work"
        : RETRY_FROM_SAVED_WORK_NEXT_ACTION),
    ),
  ];

  const runRows: NoticeMetadataRow[] = [];
  if (input.sourceRun) {
    runRows.push(runLinkRow("Source run", input.sourceRun));
    const failureCode = input.sourceRun.errorCode?.trim();
    if (failureCode) runRows.push(keyValueRow("Failure code", failureCode));
    const failureSummary = input.sourceRun.errorSummary?.trim();
    if (failureSummary) runRows.push(keyValueRow("Failure summary", failureSummary));
  }

  const sections: NoticeMetadataSection[] = [
    { title: "Recovery", rows: recoveryRows },
    ...(runRows.length > 0 ? [{ title: "Run evidence", rows: runRows }] : []),
  ];

  return {
    body,
    presentation: systemNoticePresentation({ tone: seed?.tone ?? "danger", title }),
    metadata: {
      version: 1,
      recoveryResponsibility: input.recoveryCause === "configuration_incomplete" ||
        ["provider_quota", "claude_auth_required", "acpx_auth_required"].includes(input.sourceRun?.errorCode ?? "")
        ? "user" : "system",
      sourceRunId: input.sourceRun?.id ?? null,
      sections,
    },
  };
}
