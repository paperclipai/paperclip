import { agentSlug, issueSlug } from "./identity.js";
import {
  addRunTimelineEntry,
  addWorkedOnLink,
  ensureAgentPage,
  ensureIssuePage,
  type GbrainCallable,
} from "./pages.js";

const LIMIT_CHURN_RE =
  /(?:you(?:'|\u2019)?ve hit (?:your )?(?:usage )?limit|you(?:'|\u2019)?re out of extra usage|out of (?:extra )?usage|usage limit|try again at|resets? [0-9:]+)/i;
const CONTINUE_CHURN_RE = /(?:continue from where you left off\.?|no response requested\.?)/i;
const RETRY_WAKE_RE =
  /wake reason:\s*(?:transient_failure_retry|issue_continuation_needed|process_lost_retry|missing_issue_comment|issue_blockers_resolved_sweep)/i;

export interface RunFinishedEventShape {
  eventType: string;
  companyId: string;
  payload: Record<string, unknown>;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface HandleRunFinishedInput {
  event: RunFinishedEventShape;
  /**
   * Build a gbrain client scoped to the agent. When OAuth is wired, the
   * returned client carries that agent's Bearer; without OAuth it's a
   * plain anonymous client. Called once per `agent.run.finished` after
   * the agentId is extracted from the payload.
   */
  makeClient: (agentId: string) => GbrainCallable;
  logger: Logger;
  autoRetain: boolean;
  /** Resolve human identifier (e.g. "BLO-3220") from issue UUID. */
  lookupIssueIdentifier(issueId: string): Promise<string | null>;
  /** Resolve human-readable agent name from agent UUID. */
  lookupAgentName(agentId: string): Promise<string | null>;
}

export function isRetryLimitChurnOutput(output: string): boolean {
  const limitHits = output.match(new RegExp(LIMIT_CHURN_RE, "gi"))?.length ?? 0;
  if (limitHits === 0) return false;

  const continueHits = output.match(new RegExp(CONTINUE_CHURN_RE, "gi"))?.length ?? 0;
  const retryWakeHits = output.match(new RegExp(RETRY_WAKE_RE, "gi"))?.length ?? 0;
  if (continueHits + retryWakeHits === 0) return false;

  const stripped = output
    .replace(new RegExp(LIMIT_CHURN_RE, "gi"), " ")
    .replace(new RegExp(CONTINUE_CHURN_RE, "gi"), " ")
    .replace(new RegExp(RETRY_WAKE_RE, "gi"), " ")
    .replace(/[\s\u00b7:;,.()0-9a-z]*utc[\s\u00b7:;,.()0-9a-z]*/gi, " ")
    .trim();

  return stripped.length <= 400 || (limitHits >= 2 && continueHits + retryWakeHits >= 2);
}

export async function handleRunFinished(input: HandleRunFinishedInput): Promise<HandleRunFinishedResult> {
  const { event, makeClient, logger, autoRetain, lookupIssueIdentifier, lookupAgentName } =
    input;
  if (!autoRetain) return { ok: false };

  const p = event.payload;
  const status = typeof p.status === "string" ? p.status : null;
  if (status !== "succeeded") return { ok: false };

  const runId = typeof p.runId === "string" ? p.runId : null;
  const agentId = typeof p.agentId === "string" ? p.agentId : null;
  const issueId = typeof p.issueId === "string" ? p.issueId : null;
  const finishedAt = typeof p.finishedAt === "string" ? p.finishedAt : null;
  const issueTitleFromPayload = typeof p.issueTitle === "string" ? p.issueTitle : null;
  const issueDescFromPayload =
    typeof p.issueDescription === "string" ? p.issueDescription : null;
  const output = typeof p.output === "string" ? p.output : null;

  if (!runId || !agentId || !issueId || !finishedAt || !output) {
    logger.info("gbrain retain skip: missing required payload field", {
      runId,
      agentId,
      issueId,
      hasOutput: Boolean(output),
    });
    return { ok: false };
  }

  if (isRetryLimitChurnOutput(output)) {
    logger.info("gbrain retain skip: retry/limit/continue churn", {
      runId,
      agentId,
      issueId,
    });
    return { ok: false };
  }

  try {
    const identifier = await lookupIssueIdentifier(issueId);
    const issuePageSlug = issueSlug(identifier);
    if (!issuePageSlug || !identifier) {
      logger.info("gbrain retain skip: issue identifier unresolved", { issueId });
      return { ok: false };
    }

    const agentName = await lookupAgentName(agentId);
    const agentPageSlug = agentSlug(agentName);
    if (!agentPageSlug || !agentName) {
      logger.info("gbrain retain skip: agent name unresolved", { agentId });
      return { ok: false };
    }

    const client = makeClient(agentId);

    await ensureIssuePage(client, {
      identifier,
      title: issueTitleFromPayload,
      description: issueDescFromPayload,
    });
    await ensureAgentPage(client, { agentId, agentName });
    await addWorkedOnLink(client, { agentSlug: agentPageSlug, issueSlug: issuePageSlug });
    await addRunTimelineEntry(client, {
      issueSlug: issuePageSlug,
      body: output,
      agentId,
      runId,
      companyId: event.companyId,
      outcome: status,
      finishedAt,
    });

    logger.info("gbrain retain wrote timeline entry", {
      runId,
      issueSlug: issuePageSlug,
      agentSlug: agentPageSlug,
    });
    return { ok: true, runId, agentId, issuePageSlug, agentPageSlug };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Embed the error in the message string — meta fields named `error`
    // are getting dropped by the SDK log pipeline somewhere, so without
    // this inline form the actual failure cause is invisible in logs.
    logger.warn(`gbrain retain failed (non-fatal): ${msg}`, { runId });
    return { ok: false };
  }
}

export type HandleRunFinishedResult =
  | { ok: false }
  | { ok: true; runId: string; agentId: string; issuePageSlug: string; agentPageSlug: string };
