/**
 * Default kb-ingest routines for new agents (stateless design, TECH-9763).
 *
 * Every new agent gets, in the same request that creates the agent:
 *  - two supporting issues: a long-lived "kb-ingest state" issue (holds the `ingest-state` document, i.e. the
 *    reading positions) and an "Open commitments" parent issue (parent of the commitment issues the routine files);
 *  - the ingest routine, firing every 4 hours, whose description is the master `ROUTINE.md` template of
 *    redesignhealth/rh-paperclip (`runtime/routines/kb-ingest/`) with the placeholders filled in;
 *  - the weekly commitment-hygiene routine (`HYGIENE.md`), which only comments on stale commitments.
 *
 * The routine keeps no state on local disk and fetches no code: reading positions live in an issue document,
 * knowledge goes to mem0 and Arcana, commitments are backlog issues. The templates are embedded in
 * default-kb-ingest-templates.ts; nothing is fetched at run time.
 *
 * Not seeded here: the `fetch-reference` issue document (FETCH.md with placeholders filled in). The template
 * trusts it only if a board user wrote its latest revision, so a service-written copy would either be rejected
 * by the agent or fake a human author. A board user saves it once per state issue (see the state issue's
 * description). Until then the routine stops and reports, which is the safe default.
 *
 * The briefing routine (`BRIEFING.md`) is not a default: it needs a per-person delivery target
 * (`{{DELIVERY}}`) that a new agent does not have.
 *
 * Re-running is idempotent: supporting issues are found by (origin kind, agent id), routines by (agent id,
 * title), and a missing trigger is added to an existing routine.
 *
 * `PAPERCLIP_DEFAULT_KB_INGEST_SOURCE_REF` was used by the old self-bootstrap step. It is no longer read; setting
 * it is harmless.
 */
import { and, eq } from "drizzle-orm";
import { agents, authUsers, issues, routines, routineTriggers } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { KB_INGEST_HYGIENE_TEMPLATE, KB_INGEST_ROUTINE_TEMPLATE } from "./default-kb-ingest-templates.js";
// routines.js is loaded where it is first used: the routines service reaches the heartbeat service, and a static import would pull
// that whole graph into the agent lifecycle, which imports this module (and defeats native-runtime module mocks).

const DEFAULT_KB_INGEST_ROUTINE_ENABLED_ENV = "PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED";

const KB_INGEST_CRON = "0 */4 * * *";
const KB_INGEST_HYGIENE_CRON = "0 9 * * 1";
const KB_INGEST_TIMEZONE = "UTC";

export const KB_INGEST_ROUTINE_TITLE = "kb-ingest: read sources, write knowledge, file commitments";
export const KB_INGEST_HYGIENE_ROUTINE_TITLE = "kb-ingest hygiene: stale commitments (weekly)";
export const KB_INGEST_STATE_ORIGIN_KIND = "default_kb_ingest_state";
export const KB_INGEST_COMMITMENTS_ORIGIN_KIND = "default_kb_ingest_commitments";

/** Sources a new agent ingests by default (subset of the template's list); linear/github need repo or team scoping. */
export const KB_INGEST_DEFAULT_SOURCES = ["gmail", "slack", "gdocs", "gcal", "commsboard"] as const;

const FALLBACK_OWNER = "this agent's owner";

/** Feature guard. Default OFF: unless explicitly "true", agent creation is unchanged. */
export function isDefaultKbIngestRoutineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEFAULT_KB_INGEST_ROUTINE_ENABLED_ENV]?.trim().toLowerCase() === "true";
}

/** A display name is data: one line, no markup or template characters, bounded length. */
function sanitizeInline(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/[`{}<>\r\n\t|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned || fallback;
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
}

const EMPTY_ROUTING_TABLE = [
  "Routing table: no other agent's domain is configured yet, so every domain is yours to write.",
  "",
  "| domain | agent | how to reach (child issue) |",
  "|---|---|---|",
].join("\n");

export interface KbIngestDescriptionInput {
  owner?: string | null;
  stateIssueId: string;
  commitmentsParentIssueId: string;
  sources?: readonly string[];
}

export function buildDefaultKbIngestRoutineDescription(input: KbIngestDescriptionInput): string {
  return fillTemplate(KB_INGEST_ROUTINE_TEMPLATE, {
    OWNER: sanitizeInline(input.owner, FALLBACK_OWNER),
    STATE_ISSUE_ID: input.stateIssueId,
    COMMITMENTS_PARENT_ISSUE_ID: input.commitmentsParentIssueId,
    SOURCES: (input.sources ?? KB_INGEST_DEFAULT_SOURCES).join(", "),
    ROUTING_TABLE: EMPTY_ROUTING_TABLE,
  });
}

export function buildDefaultKbIngestHygieneDescription(input: KbIngestDescriptionInput): string {
  return fillTemplate(KB_INGEST_HYGIENE_TEMPLATE, {
    OWNER: sanitizeInline(input.owner, FALLBACK_OWNER),
    STATE_ISSUE_ID: input.stateIssueId,
    COMMITMENTS_PARENT_ISSUE_ID: input.commitmentsParentIssueId,
  });
}

export function buildKbIngestStateIssueDescription(): string {
  return [
    "Long-lived state issue of this agent's kb-ingest routine. Leave it open, in backlog and unassigned.",
    "",
    "- Holds the `ingest-state` document (the routine's reading positions). Only the routine's agent writes it.",
    "- Each ingest routine needs its own state issue. Two routines on one state issue cause 409 conflicts and halted runs.",
    "- **Setup (board user, once):** save the per-source reference as the issue document `fetch-reference` on this issue. It is `FETCH.md` of `runtime/routines/kb-ingest/` in redesignhealth/rh-paperclip with the placeholders filled in: `{{STATE_ISSUE_ID}}` is this issue's id, `{{TRUSTED_COMMS_AGENTS}}` is empty unless you name comms-board agents whose invites may be accepted, `{{GITHUB_REPOS}}` is only needed if you enable `github`. The routine uses it only if a board user wrote its latest revision; until then it stops and reports.",
    "- Without a migrated `KB/` folder, the first run only initialises `ingest-state` (cursors = now) and ingests nothing.",
  ].join("\n");
}

export function buildKbIngestCommitmentsParentDescription(): string {
  return [
    "Parent of the commitment issues filed by this agent's kb-ingest routine. Leave it open, in backlog and unassigned.",
    "",
    "Each child is one commitment, created in backlog with no assignee and a fingerprint in its description. The routine comments with evidence when a commitment looks done or superseded but never closes it: a person confirms. Closing or cancelling a child is how you dismiss it; a dismissed commitment is not filed again.",
  ].join("\n");
}

interface DefaultKbIngestRoutineActor {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
}

type RoutineActor = { agentId: string | null; userId: string | null; runId: string | null };

/**
 * Create the default kb-ingest routines (and their supporting issues) for a newly created agent. No-op
 * (returns null) when the feature flag is off. Safe to call again for the same agent: existing issues and
 * routines are reused. Errors propagate to the caller — this runs in the agent-creation route after the agent
 * row already committed, so a failure here should surface as a partial-success response, not silently vanish.
 */
export async function createDefaultKbIngestRoutineForNewAgent(
  db: Db,
  input: { companyId: string; agentId: string },
  actor: DefaultKbIngestRoutineActor,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isDefaultKbIngestRoutineEnabled(env)) return null;

  const { routineService, resolveRoutineResponsibleUserId } = await import("./routines.js");
  const { issueService } = await import("./issues.js");
  const svc = routineService(db);
  const issuesSvc = issueService(db);
  const routineActor: RoutineActor = { agentId: actor.agentId ?? null, userId: actor.userId ?? null, runId: actor.runId ?? null };

  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  const agentName = sanitizeInline(agent?.name, "agent");

  // The routine's responsible user is the owner whose sources and commitments these are.
  const ownerUserId = await resolveRoutineResponsibleUserId(db, input.companyId, routineActor.userId);
  let owner: string | null = null;
  if (ownerUserId) {
    const [user] = await db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, ownerUserId));
    owner = user?.name ?? null;
  }

  async function ensureSupportingIssue(originKind: string, title: string, description: string) {
    const [existing] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.originKind, originKind), eq(issues.originId, input.agentId)));
    if (existing) return existing;
    return issuesSvc.create(input.companyId, {
      title,
      description,
      status: "backlog",
      priority: "low",
      originKind,
      originId: input.agentId,
      createdByAgentId: routineActor.agentId,
      createdByUserId: routineActor.userId,
      actorResponsibleUserId: ownerUserId,
      idempotencyKey: `${originKind}:${input.agentId}`,
    });
  }

  const stateIssue = await ensureSupportingIssue(
    KB_INGEST_STATE_ORIGIN_KIND,
    `kb-ingest state (${agentName})`,
    buildKbIngestStateIssueDescription(),
  );
  const commitmentsParent = await ensureSupportingIssue(
    KB_INGEST_COMMITMENTS_ORIGIN_KIND,
    `Open commitments (${agentName})`,
    buildKbIngestCommitmentsParentDescription(),
  );
  const descriptionInput: KbIngestDescriptionInput = {
    owner,
    stateIssueId: stateIssue.id,
    commitmentsParentIssueId: commitmentsParent.id,
  };

  async function ensureRoutine(title: string, description: string, triggerLabel: string, cronExpression: string) {
    const [existing] = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, input.companyId), eq(routines.assigneeAgentId, input.agentId), eq(routines.title, title)));
    const routine =
      existing ??
      (await svc.create(
        input.companyId,
        {
          title,
          description,
          assigneeAgentId: input.agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "skip_if_active",
          catchUpPolicy: "skip_missed",
          activityGatePolicy: "always",
          activityGateScope: "company",
          variables: [],
        },
        routineActor,
      ));
    const [existingTrigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine.id));
    if (existingTrigger) return { routine, trigger: existingTrigger };
    const { trigger } = await svc.createTrigger(
      routine.id,
      { kind: "schedule", label: triggerLabel, enabled: true, cronExpression, timezone: KB_INGEST_TIMEZONE },
      routineActor,
    );
    return { routine, trigger };
  }

  const ingest = await ensureRoutine(
    KB_INGEST_ROUTINE_TITLE,
    buildDefaultKbIngestRoutineDescription(descriptionInput),
    "every 4 hours",
    KB_INGEST_CRON,
  );
  const hygiene = await ensureRoutine(
    KB_INGEST_HYGIENE_ROUTINE_TITLE,
    buildDefaultKbIngestHygieneDescription(descriptionInput),
    "weekly, Monday 09:00",
    KB_INGEST_HYGIENE_CRON,
  );

  return {
    routine: ingest.routine,
    trigger: ingest.trigger,
    hygieneRoutine: hygiene.routine,
    hygieneTrigger: hygiene.trigger,
    stateIssue,
    commitmentsParent,
  };
}
