import { heartbeatRuns } from "@paperclipai/db";
import { sql } from "drizzle-orm";

const recoveryContextKeys = [
  "issueId", "taskId", "retryReason", "source", "wakeReason",
  "handoffReason", "handoffRequired", "handoffAttempt", "maxHandoffAttempts",
  "sourceRunId", "resumeFromRunId", "missingDisposition",
  "providerQuotaRetryNotBefore", "transientRetryNotBefore",
  "dispositionRepairAttempt", "dispositionRepairFingerprint", "legacyDispositionEpisode",
  "reviewPathRecoveryAttempt", "reviewPathConsumedRef", "interactionId", "approvalId",
  "clearReason", "monitorAttemptCount", "wakeCommentIds", "wakeCommentId", "commentId",
  "externalChatContinuation", "paperclipWake", "paperclipWorkspace",
] as const;

export const recoveryRunContextColumn = sql<Record<string, unknown> | null>`
  case when ${heartbeatRuns.contextSnapshot} is null then null else (
    select coalesce(jsonb_object_agg(field.key, case field.key
      when 'paperclipWake' then jsonb_build_object(
        'externalInteractionContinuation', field.value->'externalInteractionContinuation')
      when 'paperclipWorkspace' then jsonb_build_object('mode', field.value->'mode')
      else field.value end), '{}'::jsonb)
    from jsonb_each(case when jsonb_typeof(${heartbeatRuns.contextSnapshot}) = 'object'
      then ${heartbeatRuns.contextSnapshot} else '{}'::jsonb end) as field(key, value)
    where field.key in (${sql.join(recoveryContextKeys.map(key => sql`${key}`), sql`, `)})
  ) end
`;

export const recoveryRunVersionColumn = sql<string>`${heartbeatRuns}.xmin::text`;
