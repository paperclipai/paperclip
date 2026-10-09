import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyOnboardingSeeds, goals, issues, projects } from "@paperclipai/db";
import type { ApplyOnboardingSeed } from "@paperclipai/shared";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { agentService } from "./agents.js";
import { createAgentLifecycle, scheduleAgentLifecycle } from "./agent-lifecycle.js";
import { withDedicatedDbConnection } from "@paperclipai/db";
import { PAPERCLIP_CORE_SKILL_KEYS } from "./company-skills.js";
import { goalService } from "./goals.js";
import { projectService } from "./projects.js";
import { issueService } from "./issues.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

/**
 * The project the seeded first task lands in, matching the name the tenant's
 * own first-run wizard uses so a later manual run reuses it instead of
 * creating a second "Onboarding" project.
 */
export const ONBOARDING_SEED_PROJECT_NAME = "Onboarding";

/**
 * Role assigned to the seeded lead agent. The seed's own `agent.role` is
 * customer free text ("Chief of Staff") and lands on `title`; `role` stays the
 * structural `ceo` key the org chart and default-instructions lookup read.
 */
const SEEDED_AGENT_ROLE = "ceo";

/**
 * Adapter the seeded agent is created with. Mirrors the teams-catalog default
 * (`claude_local`), which is the safe adapter for agents created server-side
 * without a human running an environment test first.
 */
const FALLBACK_SEEDED_AGENT_ADAPTER_TYPE = "claude_local";

function seededAgentAdapterType() {
  const configured = process.env.PAPERCLIP_ONBOARDING_SEED_ADAPTER_TYPE?.trim()
    || process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE?.trim()
    || FALLBACK_SEEDED_AGENT_ADAPTER_TYPE;
  // Server-seeded onboarding deliberately stays on a direct adapter. Native
  // runner rollout is an explicit post-onboarding configuration choice.
  return configured === "paperclip_runner"
    ? FALLBACK_SEEDED_AGENT_ADAPTER_TYPE
    : configured;
}

/**
 * Adapter config for the seeded CEO. The default CEO instructions tell the
 * agent to use the core paperclip skills (hiring, memory, coordination), and
 * an agent's runtime only receives skills listed in its own desired set — so
 * a seeded CEO with an empty adapter config arrives with zero skills and
 * truthfully reports its own toolkit as not installed. Enable the core set
 * whenever the seeded adapter supports skill sync.
 */
function seededAgentAdapterConfig(adapterType: string): Record<string, unknown> {
  const adapter = findActiveServerAdapter(adapterType);
  if (!adapter?.listSkills && !adapter?.syncSkills) return {};
  return writePaperclipSkillSyncPreference(
    {},
    PAPERCLIP_CORE_SKILL_KEYS.map((key) => ({ key, versionId: null })),
  );
}

/**
 * Split a free-text mission into a goal title + description the same way the
 * first-run wizard's `parseOnboardingGoalInput` does: first line is the title,
 * the remainder is the description.
 */
export function parseSeedMission(raw: string): { title: string; description: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { title: "", description: null };

  const [firstLine, ...restLines] = trimmed.split(/\r?\n/);
  const description = restLines.join("\n").trim();
  return {
    title: (firstLine ?? "").trim(),
    description: description.length > 0 ? description : null,
  };
}

export type OnboardingSeedApplication = {
  revision: string;
  /** False when the stored revision already matched and nothing was re-applied. */
  changed: boolean;
  goalId: string | null;
  agentId: string | null;
  issueId: string | null;
};

/**
 * The actor fields the audit entry needs, as `getActorInfo` produces them.
 * Narrowed to what {@link LogActivityInput} reads so the route can hand its
 * actor straight through without the service depending on Express.
 */
export type OnboardingSeedAuditActor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

export function onboardingSeedService(db: Db) {
  async function readRecord(dbx: Db, companyId: string) {
    return dbx
      .select()
      .from(companyOnboardingSeeds)
      .where(eq(companyOnboardingSeeds.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function goalStillExists(dbx: Db, companyId: string, goalId: string | null) {
    if (!goalId) return false;
    return dbx
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.companyId, companyId)))
      .then((rows) => rows.length > 0);
  }

  /**
   * The agent a re-push should update rather than duplicate: the one this
   * seed created if it is still around, else a pre-existing lead the tenant
   * already has. Built-in agents are excluded — they are provisioned by the
   * platform and are not the customer's first hire.
   */
  async function resolveTargetAgentId(dbx: Db, companyId: string, recordedAgentId: string | null) {
    if (recordedAgentId) {
      const recorded = await dbx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, recordedAgentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (recorded) return recorded.id;
    }

    const candidates = await dbx
      .select({ id: agents.id, metadata: agents.metadata })
      .from(agents)
      .where(and(
        eq(agents.companyId, companyId),
        eq(agents.role, SEEDED_AGENT_ROLE),
        ne(agents.status, "terminated"),
      ));
    return candidates.find((row) => !readBuiltInAgentMarker(row.metadata))?.id ?? null;
  }

  async function issueStillExists(dbx: Db, companyId: string, issueId: string | null) {
    if (!issueId) return false;
    return dbx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows.length > 0);
  }

  async function resolveOnboardingProjectId(
    dbx: Db,
    projectSvc: ReturnType<typeof projectService>,
    companyId: string,
    goalId: string | null,
  ) {
    const existing = await dbx
      .select({ id: projects.id, name: projects.name, status: projects.status })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    const reusable = existing.find(
      (project) =>
        project.status !== "cancelled"
        && project.name.trim().toLowerCase() === ONBOARDING_SEED_PROJECT_NAME.toLowerCase(),
    );
    if (reusable) return reusable.id;

    const created = await projectSvc.create(companyId, {
      name: ONBOARDING_SEED_PROJECT_NAME,
      status: "in_progress",
      ...(goalId ? { goalIds: [goalId] } : {}),
    });
    return created.id;
  }

  async function prepareAgent(dbx: Db, companyId: string, seed: ApplyOnboardingSeed, audit?: OnboardingSeedAuditActor) {
    const existing = await readRecord(dbx, companyId);
    if (existing?.revision === seed.revision) return existing.agentId;
    const agentSvc = agentService(dbx);
    const agentName = seed.agent?.name.trim() || null;
    const agentRole = seed.agent?.role?.trim() || null;
    // 2. Agent → the customer's first hire, the lead the first task is
    //    assigned to.
    let agentId = await resolveTargetAgentId(dbx, companyId, existing?.agentId ?? null);
    if (agentName) {
      if (agentId) {
        await agentSvc.update(agentId, { name: agentName, title: agentRole });
      } else {
        const adapterType = seededAgentAdapterType();
        const created = await createAgentLifecycle(dbx).requestHire(companyId, {
          name: agentName,
          role: SEEDED_AGENT_ROLE,
          title: agentRole,
          adapterType,
          adapterConfig: seededAgentAdapterConfig(adapterType),
          runtimeConfig: {},
          permissions: {},
          status: "idle",
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        }, { createdByUserId: audit?.actorType === "user" ? audit.actorId : null });
        agentId = created.id;
      }
    }

    return agentId;
  }

  async function applyWithin(
    dbx: Db,
    companyId: string,
    seed: ApplyOnboardingSeed,
    preparedAgentId: string | null,
  ): Promise<OnboardingSeedApplication> {
    const goalSvc = goalService(dbx);
    const projectSvc = projectService(dbx);
    const issueSvc = issueService(dbx);

    const existing = await readRecord(dbx, companyId);
    if (existing && existing.revision === seed.revision) {
      return {
        revision: existing.revision,
        changed: false,
        goalId: existing.goalId,
        agentId: existing.agentId,
        issueId: existing.issueId,
      };
    }

    const mission = seed.mission?.trim() || null;
    const agentName = seed.agent?.name.trim() || null;
    const agentRole = seed.agent?.role?.trim() || null;
    const firstTaskTitle = seed.firstTask?.title.trim() || null;
    const firstTaskDetails = seed.firstTask?.details?.trim() || null;

    // 1. Mission → the company-level goal the dashboard reads.
    let goalId = existing?.goalId ?? null;
    if (mission) {
      const parsed = parseSeedMission(mission);
      const target = (await goalStillExists(dbx, companyId, goalId))
        ? goalId
        : (await goalSvc.getDefaultCompanyGoal(companyId))?.id ?? null;
      if (target) {
        await goalSvc.update(target, {
          title: parsed.title,
          description: parsed.description,
        });
        goalId = target;
      } else {
        const created = await goalSvc.create(companyId, {
          title: parsed.title,
          description: parsed.description,
          level: "company",
          status: "active",
        });
        goalId = created.id;
      }
    }

    const agentId = preparedAgentId;

    // A mission-only seed leaves the first task to the onboarding route.
    let issueId = existing?.issueId ?? null;
    if (firstTaskTitle) {
      if (await issueStillExists(dbx, companyId, issueId)) {
        await issueSvc.update(
          issueId as string,
          {
            title: firstTaskTitle,
            description: firstTaskDetails,
            // Keep the task's relationships in step with a later revision that
            // supplied the agent or goal after the task already existed —
            // otherwise the record would report an assignee/goal the issue row
            // does not actually carry. Only set them when resolved, so an
            // absent value never clears an assignment the tenant made.
            ...(agentId ? { assigneeAgentId: agentId } : {}),
            ...(goalId ? { goalId } : {}),
          },
          dbx,
        );
      } else {
        const projectId = await resolveOnboardingProjectId(dbx, projectSvc, companyId, goalId);
        // The idempotency key is what protects two pushes that arrive at once
        // — Cloud's reconcile runs off portfolio fetches, which can overlap.
        // It is deliberately not revision-scoped: if the recorded issue is
        // lost, a later revision should still dedupe against whatever the
        // first push created.
        const created = await issueSvc.create(companyId, {
          title: firstTaskTitle,
          ...(firstTaskDetails ? { description: firstTaskDetails } : {}),
          ...(agentId ? { assigneeAgentId: agentId } : {}),
          projectId,
          ...(goalId ? { goalId } : {}),
          status: "todo",
          idempotencyKey: `onboarding-seed:${companyId}`,
        });
        issueId = created.id;
      }
    }

    // 4. Record the revision last. Everything above has to have landed before
    //    this row claims the seed is applied.
    const now = new Date();
    const values = {
      companyId,
      revision: seed.revision,
      mission,
      agentName,
      agentRole,
      firstTaskTitle,
      firstTaskDetails,
      goalId,
      agentId,
      issueId,
      appliedAt: now,
      updatedAt: now,
    };
    await dbx
      .insert(companyOnboardingSeeds)
      .values(values)
      .onConflictDoUpdate({
        target: companyOnboardingSeeds.companyId,
        set: {
          revision: values.revision,
          mission: values.mission,
          agentName: values.agentName,
          agentRole: values.agentRole,
          firstTaskTitle: values.firstTaskTitle,
          firstTaskDetails: values.firstTaskDetails,
          goalId: values.goalId,
          agentId: values.agentId,
          issueId: values.issueId,
          appliedAt: values.appliedAt,
          updatedAt: values.updatedAt,
        },
      });

    return { revision: seed.revision, changed: true, goalId, agentId, issueId };
  }

  // Hire first. If the content transaction fails, a retry reuses the committed agent.
  // The dedicated transaction holds only the workflow lock, not the hire writes.
  async function apply(
    companyId: string,
    seed: ApplyOnboardingSeed,
    audit?: OnboardingSeedAuditActor,
  ): Promise<OnboardingSeedApplication> {
    // Collected inside the transaction, published only after it commits: the
    // activity row is transactional but its realtime/plugin fan-out is not, and
    // announcing a seed that then rolled back would be worse than announcing it
    // late.
    const publications: ActivityPublication[] = [];

    const database = db;
    const lockKey = `paperclip:onboarding-seed:${companyId}`;
    return withDedicatedDbConnection(db, lockDb => lockDb.transaction(async lock => {
      await lock.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const preparedAgentId = await prepareAgent(database, companyId, seed, audit);
      const result = await database.transaction(async (tx) => {
        const dbx = tx as unknown as Db;
        const applied = await applyWithin(dbx, companyId, seed, preparedAgentId);

        if (applied.changed && audit) {
          await logActivity(
            dbx,
            {
              companyId,
              actorType: audit.actorType,
              actorId: audit.actorId,
              agentId: audit.agentId,
              runId: audit.runId,
              agentApiKeyId: audit.agentApiKeyId,
              action: "company.onboarding_seed_applied",
              entityType: "company",
              entityId: companyId,
              details: {
                revision: applied.revision,
                goalId: applied.goalId,
                agentId: applied.agentId,
                issueId: applied.issueId,
              },
            },
            publications,
          );
        }

        return applied;
      });

      for (const publication of publications) publishActivity(publication);
      if (result.agentId) scheduleAgentLifecycle(db, result.agentId);
      return result;
    }));
  }

  return { apply, get: (companyId: string) => readRecord(db, companyId) };
}
