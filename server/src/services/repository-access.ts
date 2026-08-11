import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentRepositoryGrants,
  agents,
  projectRepositories,
  projects,
  repositories,
} from "@paperclipai/db";
import type {
  AgentRepositoryGrantEntry,
  EffectiveRepositoryAccess,
  ProjectRepositoryEntry,
  Repository,
} from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { toRepository } from "./repositories.js";

type ProjectAccessCandidate = { id: string; name: string; companyId: string };

function toProjectEntry(row: {
  link: typeof projectRepositories.$inferSelect;
  repository: typeof repositories.$inferSelect;
}): ProjectRepositoryEntry {
  return {
    link: row.link,
    repository: toRepository(row.repository),
  };
}

function toGrantEntry(row: {
  grant: typeof agentRepositoryGrants.$inferSelect;
  repository: typeof repositories.$inferSelect;
}): AgentRepositoryGrantEntry {
  return {
    grant: row.grant,
    repository: toRepository(row.repository),
  };
}

export function repositoryAccessService(db: Db) {
  async function getProject(companyId: string, projectId: string) {
    return db
      .select({ id: projects.id, name: projects.name, companyId: projects.companyId })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getAgent(companyId: string, agentId: string) {
    return db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .then((rows) => rows[0] ?? null);
  }

  async function getRepository(companyId: string, repositoryId: string) {
    return db
      .select()
      .from(repositories)
      .where(and(eq(repositories.companyId, companyId), eq(repositories.id, repositoryId)))
      .then((rows) => rows[0] ?? null);
  }

  async function requireActiveRepository(companyId: string, repositoryId: string) {
    const repository = await getRepository(companyId, repositoryId);
    if (!repository) return null;
    if (repository.state !== "active") throw conflict("Archived or unavailable repository cannot receive new access sources");
    return repository;
  }

  return {
    listProjectRepositories: async (companyId: string, projectId: string): Promise<ProjectRepositoryEntry[] | null> => {
      if (!(await getProject(companyId, projectId))) return null;
      const rows = await db
        .select({ link: projectRepositories, repository: repositories })
        .from(projectRepositories)
        .innerJoin(repositories, eq(projectRepositories.repositoryId, repositories.id))
        .where(and(
          eq(projectRepositories.companyId, companyId),
          eq(projectRepositories.projectId, projectId),
          eq(repositories.companyId, companyId),
        ))
        .orderBy(asc(projectRepositories.displayOrder), asc(repositories.host), asc(repositories.owner), asc(repositories.name));
      return rows.map(toProjectEntry);
    },

    attachProjectRepository: async (input: {
      companyId: string;
      projectId: string;
      repositoryId: string;
      displayOrder: number;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const [project, repository] = await Promise.all([
        getProject(input.companyId, input.projectId),
        requireActiveRepository(input.companyId, input.repositoryId),
      ]);
      if (!project || !repository) return null;
      const existing = await db
        .select()
        .from(projectRepositories)
        .where(and(
          eq(projectRepositories.companyId, input.companyId),
          eq(projectRepositories.projectId, input.projectId),
          eq(projectRepositories.repositoryId, input.repositoryId),
        ))
        .then((rows) => rows[0] ?? null);
      const now = new Date();
      const link = await db
        .insert(projectRepositories)
        .values({
          companyId: input.companyId,
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          displayOrder: input.displayOrder,
          createdByAgentId: input.createdByAgentId ?? null,
          createdByUserId: input.createdByUserId ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [projectRepositories.companyId, projectRepositories.projectId, projectRepositories.repositoryId],
          set: { displayOrder: input.displayOrder, updatedAt: now },
        })
        .returning()
        .then((rows) => rows[0]!);
      return { entry: toProjectEntry({ link, repository }), created: !existing };
    },

    detachProjectRepository: async (companyId: string, projectId: string, repositoryId: string) => {
      const [project, repository] = await Promise.all([
        getProject(companyId, projectId),
        getRepository(companyId, repositoryId),
      ]);
      if (!project || !repository) return null;
      const removed = await db
        .delete(projectRepositories)
        .where(and(
          eq(projectRepositories.companyId, companyId),
          eq(projectRepositories.projectId, projectId),
          eq(projectRepositories.repositoryId, repositoryId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      return { removed: Boolean(removed), link: removed };
    },

    listDirectGrants: async (companyId: string, agentId: string): Promise<AgentRepositoryGrantEntry[] | null> => {
      if (!(await getAgent(companyId, agentId))) return null;
      const rows = await db
        .select({ grant: agentRepositoryGrants, repository: repositories })
        .from(agentRepositoryGrants)
        .innerJoin(repositories, eq(agentRepositoryGrants.repositoryId, repositories.id))
        .where(and(
          eq(agentRepositoryGrants.companyId, companyId),
          eq(agentRepositoryGrants.agentId, agentId),
          eq(repositories.companyId, companyId),
        ))
        .orderBy(asc(repositories.host), asc(repositories.owner), asc(repositories.name));
      return rows.map(toGrantEntry);
    },

    grantAgentRepository: async (input: {
      companyId: string;
      agentId: string;
      repositoryId: string;
      grantedByAgentId?: string | null;
      grantedByUserId?: string | null;
    }) => {
      const [agent, repository] = await Promise.all([
        getAgent(input.companyId, input.agentId),
        requireActiveRepository(input.companyId, input.repositoryId),
      ]);
      if (!agent || !repository) return null;
      const existing = await db
        .select()
        .from(agentRepositoryGrants)
        .where(and(
          eq(agentRepositoryGrants.companyId, input.companyId),
          eq(agentRepositoryGrants.agentId, input.agentId),
          eq(agentRepositoryGrants.repositoryId, input.repositoryId),
        ))
        .then((rows) => rows[0] ?? null);
      if (existing) return { entry: toGrantEntry({ grant: existing, repository }), created: false };
      const grant = await db
        .insert(agentRepositoryGrants)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          repositoryId: input.repositoryId,
          grantedByAgentId: input.grantedByAgentId ?? null,
          grantedByUserId: input.grantedByUserId ?? null,
        })
        .onConflictDoNothing({
          target: [agentRepositoryGrants.companyId, agentRepositoryGrants.agentId, agentRepositoryGrants.repositoryId],
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      const resolved = grant ?? await db
        .select()
        .from(agentRepositoryGrants)
        .where(and(
          eq(agentRepositoryGrants.companyId, input.companyId),
          eq(agentRepositoryGrants.agentId, input.agentId),
          eq(agentRepositoryGrants.repositoryId, input.repositoryId),
        ))
        .then((rows) => rows[0]!);
      return { entry: toGrantEntry({ grant: resolved, repository }), created: Boolean(grant) };
    },

    revokeAgentRepository: async (companyId: string, agentId: string, repositoryId: string) => {
      const [agent, repository] = await Promise.all([
        getAgent(companyId, agentId),
        getRepository(companyId, repositoryId),
      ]);
      if (!agent || !repository) return null;
      const removed = await db
        .delete(agentRepositoryGrants)
        .where(and(
          eq(agentRepositoryGrants.companyId, companyId),
          eq(agentRepositoryGrants.agentId, agentId),
          eq(agentRepositoryGrants.repositoryId, repositoryId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      return { removed: Boolean(removed), grant: removed };
    },

    listEffectiveRepositories: async (input: {
      companyId: string;
      agentId: string;
      canAccessProject: (project: ProjectAccessCandidate) => Promise<boolean>;
    }): Promise<EffectiveRepositoryAccess[] | null> => {
      if (!(await getAgent(input.companyId, input.agentId))) return null;
      const [directRows, inheritedRows] = await Promise.all([
        db
          .select({ repository: repositories })
          .from(agentRepositoryGrants)
          .innerJoin(repositories, eq(agentRepositoryGrants.repositoryId, repositories.id))
          .where(and(
            eq(agentRepositoryGrants.companyId, input.companyId),
            eq(agentRepositoryGrants.agentId, input.agentId),
            eq(repositories.companyId, input.companyId),
            eq(repositories.state, "active"),
          )),
        db
          .select({
            project: { id: projects.id, name: projects.name, companyId: projects.companyId },
            repository: repositories,
          })
          .from(projectRepositories)
          .innerJoin(projects, eq(projectRepositories.projectId, projects.id))
          .innerJoin(repositories, eq(projectRepositories.repositoryId, repositories.id))
          .where(and(
            eq(projectRepositories.companyId, input.companyId),
            eq(projects.companyId, input.companyId),
            eq(repositories.companyId, input.companyId),
            eq(repositories.state, "active"),
          )),
      ]);

      const projectsById = new Map<string, ProjectAccessCandidate>();
      for (const row of inheritedRows) projectsById.set(row.project.id, row.project);
      const accessDecisions = await Promise.all(
        [...projectsById.values()].map(async (project) => [project.id, await input.canAccessProject(project)] as const),
      );
      const accessibleProjectIds = new Set(accessDecisions.filter(([, allowed]) => allowed).map(([id]) => id));

      const effective = new Map<string, EffectiveRepositoryAccess>();
      const ensure = (repository: typeof repositories.$inferSelect) => {
        let entry = effective.get(repository.id);
        if (!entry) {
          entry = { repository: toRepository(repository), sources: { direct: false, projects: [] } };
          effective.set(repository.id, entry);
        }
        return entry;
      };
      for (const row of directRows) ensure(row.repository).sources.direct = true;
      for (const row of inheritedRows) {
        if (!accessibleProjectIds.has(row.project.id)) continue;
        ensure(row.repository).sources.projects.push({ id: row.project.id, name: row.project.name });
      }

      return [...effective.values()]
        .map((entry) => ({
          ...entry,
          sources: {
            ...entry.sources,
            projects: entry.sources.projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
          },
        }))
        .sort((a, b) => {
          const left: Repository = a.repository;
          const right: Repository = b.repository;
          return left.host.localeCompare(right.host)
            || left.owner.localeCompare(right.owner)
            || left.name.localeCompare(right.name)
            || left.id.localeCompare(right.id);
        });
    },
  };
}
