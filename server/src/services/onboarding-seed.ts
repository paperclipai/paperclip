import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyOnboardingSeeds, goals, issues, projects } from "@paperclipai/db";
import type { ApplyOnboardingSeed } from "@paperclipai/shared";
import { agentService } from "./agents.js";
import { goalService } from "./goals.js";
import { projectService } from "./projects.js";
import { issueService } from "./issues.js";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";

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

export function onboardingSeedService(db: Db) {
  const agentSvc = agentService(db);
  const goalSvc = goalService(db);
  const projectSvc = projectService(db);
  const issueSvc = issueService(db);

  async function readRecord(companyId: string) {
    return db
      .select()
      .from(companyOnboardingSeeds)
      .where(eq(companyOnboardingSeeds.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function goalStillExists(companyId: string, goalId: string | null) {
    if (!goalId) return false;
    return db
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
  async function resolveTargetAgentId(companyId: string, recordedAgentId: string | null) {
    if (recordedAgentId) {
      const recorded = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, recordedAgentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (recorded) return recorded.id;
    }

    const candidates = await db
      .select({ id: agents.id, metadata: agents.metadata })
      .from(agents)
      .where(and(
        eq(agents.companyId, companyId),
        eq(agents.role, SEEDED_AGENT_ROLE),
        ne(agents.status, "terminated"),
      ));
    return candidates.find((row) => !readBuiltInAgentMarker(row.metadata))?.id ?? null;
  }

  async function issueStillExists(companyId: string, issueId: string | null) {
    if (!issueId) return false;
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows.length > 0);
  }

  async function resolveOnboardingProjectId(companyId: string, goalId: string | null) {
    const existing = await db
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
   */
  async function apply(
    companyId: string,
    seed: ApplyOnboardingSeed,
  ): Promise<OnboardingSeedApplication> {
    const existing = await readRecord(companyId);
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
      const target = (await goalStillExists(companyId, goalId))
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
    let agentId = await resolveTargetAgentId(companyId, existing?.agentId ?? null);
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
    let issueId = existing?.issueId ?? null;
    if (firstTaskTitle) {
      if (await issueStillExists(companyId, issueId)) {
        await issueSvc.update(issueId as string, {
          title: firstTaskTitle,
          description: firstTaskDetails,
        });
      } else {
        const projectId = await resolveOnboardingProjectId(companyId, goalId);
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
    await db
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

  return { apply, get: readRecord };
}
