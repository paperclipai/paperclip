import type { IssueCommentMetadata, IssueCommentPresentation } from "@paperclipai/shared";
import {
  agentLinkRow,
  keyValueRow,
  runLinkRow,
  systemNoticePresentation,
  type NoticeMetadataRow,
  type NoticeMetadataSection,
} from "./notice-format.js";

// Short human-readable body plus the presentation header for one recovery
// family. The escalation path merges in the metadata rows only it knows
// (recovery action, owner, source run) via buildStrandedRecoveryEscalationNotice.
export type StrandedRecoveryNoticeSeed = {
  body: string;
  title: string;
  tone: IssueCommentPresentation["tone"];
};

export type StrandedRecoveryEscalationNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

export const DEFAULT_STRANDED_RECOVERY_NOTICE_BODY =
  "Paperclip could not restore a live execution path for this issue automatically. " +
  "Moving it to `blocked` so it is visible for intervention.";

const DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE = "Automatic recovery blocked";

const STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE: Record<string, string> = {
  workspace_validation_failed: "Workspace validation failed",
  configuration_incomplete: "Configuration incomplete",
  execution_review_participant_recovery: "Review recovery stalled",
};

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return readObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The model id the provider rejected, when the failure was an unsupported
 * `adapterConfig.model`. Lives here rather than in heartbeat.ts so the recovery
 * sweep can use it too without importing heartbeat (that direction is a cycle).
 * Null for every other configuration failure (missing secrets), which keeps the
 * generic notice body.
 */
export function readRejectedAdapterModelFromRun(
  run: { errorCode?: string | null; resultJson?: unknown } | null | undefined,
): string | null {
  if (!run || run.errorCode !== "model_not_found") return null;
  const unsupportedModel = readObject(readObject(run.resultJson).unsupportedModel);
  for (const key of ["rejectedModel", "configuredModel"]) {
    const value = unsupportedModel[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

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
      "Paperclip stopped before launching the local adapter because the issue workspace failed validation. " +
      "Moving it to `blocked` so the workspace link, cwd, or git checkout can be repaired before resuming.",
    title: "Workspace validation failed",
    tone: "danger",
  };
}

export function buildConfigurationIncompleteRecoveryNoticeSeed(
  input?: { rejectedModel?: string | null } | null,
): StrandedRecoveryNoticeSeed {
  // A rejected model id is a different repair than a missing secret, so it gets
  // its own body: an operator reading "bind the missing secret(s)" would look in
  // the wrong place entirely. Name the setting (`adapterConfig.model`) and the
  // exact rejected value so the fix needs no log archaeology.
  const rejectedModel = input?.rejectedModel?.trim();
  if (rejectedModel) {
    return {
      body:
        `The model provider rejected the agent's configured model \`${rejectedModel}\`. ` +
        "This is a permanent configuration error: every retry would send the same rejected model and burn " +
        "another run's tokens, so Paperclip failed once and stopped rescheduling. " +
        "Moving the issue to `blocked` so the recovery owner below can set a supported value for " +
        "`adapterConfig.model` on the agent (see `GET /api/companies/{companyId}/adapters/{type}/models`) " +
        "before resuming.",
      title: "Configuration incomplete",
      tone: "danger",
    };
  }
  return {
    body:
      "Paperclip stopped before dispatching the adapter because required secret/env bindings are missing. " +
      "Moving it to `blocked` so an operator can bind the missing secret(s) before resuming.",
    title: "Configuration incomplete",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantRecoveryNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "Paperclip retried the pending execution-review participant once, but the review stage still has no " +
      "completed decision or live reviewer run. Moving it to `blocked` so the board can inspect the evidence, repair the " +
      "reviewer runtime, restore the review stage, or record an intentional manual resolution.",
    title: "Review recovery stalled",
    tone: "danger",
  };
}

export function buildExecutionReviewParticipantUnavailableNoticeSeed(): StrandedRecoveryNoticeSeed {
  return {
    body:
      "Paperclip cannot continue the pending execution-review participant because the participant is not " +
      "invokable and the review stage has no completed decision or live reviewer run. Moving it to `blocked` " +
      "so the board can inspect the evidence, repair the reviewer runtime, restore the review stage, or record an " +
      "intentional manual resolution.",
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
  recoveryOwner: { id: string; name: string | null } | null | undefined;
  sourceRun: {
    id: string;
    agentId?: string | null;
    status: string;
    errorCode?: string | null;
    errorSummary?: string | null;
  } | null | undefined;
}): StrandedRecoveryEscalationNotice {
  const fallbackBody = input.fallbackBody?.trim();
  const body = input.seed?.body ?? (fallbackBody || DEFAULT_STRANDED_RECOVERY_NOTICE_BODY);
  const title = input.seed?.title ??
    STRANDED_RECOVERY_NOTICE_TITLES_BY_CAUSE[input.recoveryCause ?? ""] ??
    DEFAULT_STRANDED_RECOVERY_NOTICE_TITLE;

  const recoveryRows: NoticeMetadataRow[] = [
    keyValueRow("Recovery action", input.recoveryActionId),
    input.recoveryOwner
      ? agentLinkRow("Recovery owner", input.recoveryOwner)
      : keyValueRow(
          "Recovery owner",
          "Board decision required",
        ),
    keyValueRow(
      "Next action",
      input.recoveryOwner
        ? "The recovery owner should either restore a live execution path or record the manual resolution on the source issue"
        : "Inspect the evidence, then retry the original owner, explicitly reassign, repair the execution path, or record an intentional resolution",
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
    presentation: systemNoticePresentation({ tone: input.seed?.tone ?? "danger", title }),
    metadata: {
      version: 1,
      sourceRunId: input.sourceRun?.id ?? null,
      sections,
    },
  };
}
