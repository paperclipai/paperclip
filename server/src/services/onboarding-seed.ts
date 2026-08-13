import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyOnboardingSeeds, goals, issues, projects } from "@paperclipai/db";
import type { ApplyOnboardingSeed } from "@paperclipai/shared";
import { agentService } from "./agents.js";
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
  return process.env.PAPERCLIP_ONBOARDING_SEED_ADAPTER_TYPE?.trim()
    || process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE?.trim()
    || FALLBACK_SEEDED_AGENT_ADAPTER_TYPE;
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

  /**
   * The seed application proper, run inside the per-company transaction the
   * public `apply` opens. Every read and write goes through `dbx` — the locked
   * transaction — so it is serialized against a concurrent push for the same
   * company. Services are reconstructed on `dbx` for the same reason.
   */
  async function applyWithin(
    dbx: Db,
    companyId: string,
    seed: ApplyOnboardingSeed,
  ): Promise<OnboardingSeedApplication> {
    const agentSvc = agentService(dbx);
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

    // 2. Agent → the customer's first hire, the lead the first task is
    //    assigned to.
    let agentId = await resolveTargetAgentId(dbx, companyId, existing?.agentId ?? null);
    if (agentName) {
      if (agentId) {
        await agentSvc.update(agentId, { name: agentName, title: agentRole });
      } else {
        const created = await agentSvc.create(companyId, {
          name: agentName,
          role: SEEDED_AGENT_ROLE,
          title: agentRole,
          adapterType: seededAgentAdapterType(),
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
          status: "idle",
          spentMonthlyCents: 0,
          lastHeartbeatAt: null,
        });
        agentId = created.id;
      }
    }

    // 3. First task → an issue in the Onboarding project, assigned to the
    //    lead so the dashboard opens with work on it.
    //
    //    No-first-task contract (PAP-67 r17.4): on the Cloud walk this branch
    //    never runs. The seed Cloud sends is mission-only — `agent` and
    //    `firstTask` are unpopulated by the signup wizard and a paperclip-cloud
    //    `node:test` in `src/onboarding/` pins that — so `firstTaskTitle` is
    //    null here and the first task stays owned by the tenant's own
    //    server-owned onboarding path (`POST /issues` with
    //    `onboardingFirstTask: true`). That path is the only one that stamps
    //    `ONBOARDING_FIRST_TASK_ORIGIN_KIND` and races safely on the partial
    //    unique index `issues_onboarding_first_task_uq`. If this receiver ever
    //    created the first task on the cloud walk it would produce a *second*,
    //    unstamped one: no agent-authored greeting, the brief rendered as a
    //    right-aligned user bubble, and two onboarding tasks — silently,
    //    because the uq index only guards origin-stamped rows. The branch is
    //    retained for the endpoint's documented body contract, but the
    //    mission-only seed is what keeps it inert on the cloud path.
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

  /**
   * Apply an onboarding seed to a company.
   *
   * Idempotent per `revision`: a replay of the revision already stored is a
   * no-op that still reports success, because Cloud reads any 2xx as "the
   * tenant holds this content" and retries otherwise. A *different* revision
   * (the customer edited their answers in Cloud) updates the goal, agent and
   * task this seed previously created rather than creating a second set.
   *
   * Every write happens before the caller responds — Cloud records the applied
   * revision only on a 2xx, and the redirect into the tenant dashboard is
   * gated on it, so a partially-applied seed must surface as a failure rather
   * than as an acknowledged one.
   *
   * Concurrency: Cloud's reconcile runs off portfolio fetches, which can
   * overlap, so two pushes for the same company can arrive at once. Both would
   * otherwise pass the revision check before either wrote the seed record and
   * each create a company goal, a lead agent and an Onboarding project. A
   * per-company advisory lock held for the transaction serializes them — the
   * same idiom `folders` and `decision-queues` use — so the second push sees
   * the first push's writes (the record, the reused goal/agent/project) and
   * updates in place instead of duplicating.
   *
   * Auditing: when `audit` is supplied and the push changed anything, the
   * `company.onboarding_seed_applied` entry is written *inside* this same
   * transaction. That is the only arrangement in which the entry cannot go
   * permanently missing. Logging after the commit forces a choice between two
   * broken outcomes — answer 500 and the retry returns `changed: false` and
   * never logs, or answer 200 and Cloud stops retrying while the entry stays
   * absent. Writing it transactionally removes the choice: either both land, or
   * neither does and the retry re-applies from a clean slate.
   */
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

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:onboarding-seed:${companyId}`}, 0))`,
      );
      const dbx = tx as unknown as Db;
      const applied = await applyWithin(dbx, companyId, seed);

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
    return result;
  }

  return { apply, get: (companyId: string) => readRecord(db, companyId) };
}
