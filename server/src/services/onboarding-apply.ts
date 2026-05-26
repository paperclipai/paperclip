import { sql } from "drizzle-orm";
import {
  agents,
  companyOnboardingSetups,
  companies,
  environments,
  goals,
  issues,
  projectWorkspaces,
  projects,
  type Db,
} from "@paperclipai/db";
import type {
  OnboardingApplyRequest,
  OnboardingApplyResponse,
} from "@paperclipai/shared";

import { logActivity } from "./activity-log.js";
import { ensureLocalWorkspaceGitRepo } from "./onboarding-workspace-git.js";
import { DEFAULT_ONBOARDING_SETUP_ITEMS } from "./onboarding-setup-state.js";

const ISSUE_PREFIX_FALLBACK = "CMP";
const DEFAULT_LOCAL_ENVIRONMENT_NAME = "Local";
const DEFAULT_LOCAL_ENVIRONMENT_DESCRIPTION =
  "Default execution environment for Paperclip runs on this machine.";

function deriveIssuePrefixBase(name: string) {
  const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
  return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
}

function suffixForAttempt(attempt: number) {
  if (attempt <= 1) return "";
  return "A".repeat(attempt - 1);
}

async function allocateIssuePrefix(db: Db, name: string) {
  const base = deriveIssuePrefixBase(name);
  const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
  const used = new Set(rows.map((row) => row.issuePrefix));
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidate = `${base}${suffixForAttempt(attempt)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate unique issue prefix");
}

function adapterConfigForSquad(squad: OnboardingApplyRequest["proposedSquads"][number]) {
  if (squad.model) {
    return { model: squad.model };
  }
  return {};
}

function findStarterAssignee(
  createdAgents: Array<{ id: string; role: string; name: string; adapterType: string }>,
  assigneeRole: string,
) {
  const normalizedRole = assigneeRole.trim().toLowerCase();
  return (
    createdAgents.find((agent) => agent.role.trim().toLowerCase() === normalizedRole)
    ?? createdAgents.find((agent) => agent.role.trim().toLowerCase().includes(normalizedRole))
    ?? createdAgents.find((agent) => agent.adapterType === "codex_local")
    ?? createdAgents[0]
    ?? null
  );
}

export async function applyOnboardingSetup(
  db: Db,
  input: OnboardingApplyRequest,
  actor: {
    actorType: "user" | "system";
    actorId: string;
  },
): Promise<OnboardingApplyResponse> {
  const issuePrefix = await allocateIssuePrefix(db, input.proposedCompany.name);

  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const [company] = await tx
      .insert(companies)
      .values({
        name: input.proposedCompany.name,
        description: input.proposedCompany.description ?? null,
        issuePrefix,
        status: "active",
        requireBoardApprovalForNewAgents: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await tx
      .insert(environments)
      .values({
        companyId: company.id,
        name: DEFAULT_LOCAL_ENVIRONMENT_NAME,
        description: DEFAULT_LOCAL_ENVIRONMENT_DESCRIPTION,
        driver: "local",
        status: "active",
        config: {},
        metadata: {
          managedByPaperclip: true,
          defaultForCompany: true,
          createdBy: "first_run_onboarding",
        },
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [environments.companyId, environments.driver],
        where: sql`${environments.driver} = 'local'`,
      });

    const [goal] = await tx
      .insert(goals)
      .values({
        companyId: company.id,
        title: `${input.proposedCompany.name} Operating Goal`,
        description: input.proposedCompany.description ?? "First-run onboarding root goal.",
        level: "company",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const ceoSquad = input.proposedSquads.find((squad) => squad.role === "governance");
    const createdAgents = [] as Array<{
      id: string;
      name: string;
      role: string;
      adapterType: "claude_local" | "codex_local" | "agy_local";
    }>;

    for (const squad of input.proposedSquads) {
      const [agent] = await tx
        .insert(agents)
        .values({
          companyId: company.id,
          name: squad.name,
          role: squad.role,
          title: squad.name,
          status: "idle",
          adapterType: squad.adapterType,
          adapterConfig: adapterConfigForSquad(squad),
          runtimeConfig: {},
          permissions: squad.permissions,
          reportsTo: ceoSquad && squad.name !== ceoSquad.name ? createdAgents[0]?.id ?? null : null,
          metadata: {
            createdBy: "first_run_onboarding",
            recommendedModel: squad.model,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      createdAgents.push({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        adapterType: agent.adapterType as "claude_local" | "codex_local" | "agy_local",
      });
    }

    const leadAgent = createdAgents.find((agent) => agent.adapterType === "codex_local") ?? createdAgents[0] ?? null;
    const [project] = await tx
      .insert(projects)
      .values({
        companyId: company.id,
        goalId: goal.id,
        name: input.proposedCompany.name,
        description: "Primary project created by first-run onboarding.",
        status: "planned",
        leadAgentId: leadAgent?.id ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [workspace] = await tx
      .insert(projectWorkspaces)
      .values({
        companyId: company.id,
        projectId: project.id,
        name: input.proposedProjectWorkspace.name,
        sourceType: "local_path",
        cwd: input.proposedProjectWorkspace.cwd,
        isPrimary: true,
        metadata: {
          createdBy: "first_run_onboarding",
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [counter] = await tx
      .update(companies)
      .set({
        issueCounter: sql`${companies.issueCounter} + 1`,
        updatedAt: now,
      })
      .where(sql`${companies.id} = ${company.id}`)
      .returning({
        issueCounter: companies.issueCounter,
        issuePrefix: companies.issuePrefix,
      });

    const starterAssignee = findStarterAssignee(createdAgents, input.proposedStarterIssue.assigneeRole);
    const issueNumber = counter.issueCounter;
    const identifier = `${counter.issuePrefix}-${issueNumber}`;
    const [starterIssue] = await tx
      .insert(issues)
      .values({
        companyId: company.id,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
        goalId: goal.id,
        title: input.proposedStarterIssue.title,
        description: input.proposedStarterIssue.description,
        status: "backlog",
        priority: "high",
        assigneeAgentId: starterAssignee?.id ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        issueNumber,
        identifier,
        originKind: "onboarding",
        originId: "first-run",
        originFingerprint: "first-run-starter",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [setupState] = await tx
      .insert(companyOnboardingSetups)
      .values({
        companyId: company.id,
        starterIssueId: starterIssue.id,
        status: "pending",
        source: "first_run",
        items: DEFAULT_ONBOARDING_SETUP_ITEMS,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const activityDb = tx as unknown as Db;
    await logActivity(activityDb, {
      companyId: company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "onboarding.applied",
      entityType: "company",
      entityId: company.id,
      details: {
        companyName: company.name,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
        starterIssueId: starterIssue.id,
        onboardingSetupId: setupState.id,
        squadCount: createdAgents.length,
      },
    });
    await logActivity(activityDb, {
      companyId: company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "issue.created",
      entityType: "issue",
      entityId: starterIssue.id,
      agentId: starterAssignee?.id ?? null,
      details: {
        title: starterIssue.title,
        identifier: starterIssue.identifier,
        originKind: starterIssue.originKind,
      },
    });

    return {
      company: {
        id: company.id,
        name: company.name,
        issuePrefix: company.issuePrefix,
      },
      goal: {
        id: goal.id,
        title: goal.title,
      },
      agents: createdAgents,
      project: {
        id: project.id,
        name: project.name,
      },
      projectWorkspace: {
        id: workspace.id,
        name: workspace.name,
        cwd: workspace.cwd ?? "",
      },
      starterIssue: {
        id: starterIssue.id,
        identifier: starterIssue.identifier ?? identifier,
        title: starterIssue.title,
        assigneeAgentId: starterIssue.assigneeAgentId ?? null,
      },
    };
  });

  // Make the new project workspace runnable by local adapters. `codex_local`
  // (and other local CLIs) refuse to start in a directory that is not a git
  // work tree, which would otherwise block the very first starter audit on
  // greenfield/non-git folders. Best-effort and non-fatal: never let this fail
  // the committed setup, only initialize a real, existing, not-yet-tracked dir.
  const gitReadiness = await ensureLocalWorkspaceGitRepo(result.projectWorkspace.cwd);
  if (gitReadiness.status === "initialized" || gitReadiness.status === "failed") {
    await logActivity(db, {
      companyId: result.company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action:
        gitReadiness.status === "initialized"
          ? "onboarding.workspace_git_initialized"
          : "onboarding.workspace_git_init_failed",
      entityType: "project_workspace",
      entityId: result.projectWorkspace.id,
      details: {
        cwd: result.projectWorkspace.cwd,
        ...(gitReadiness.detail ? { detail: gitReadiness.detail } : {}),
      },
    }).catch(() => {
      // Activity logging is observability-only; never let it surface as an
      // onboarding failure after the setup has already been committed.
    });
  }

  return result;
}
