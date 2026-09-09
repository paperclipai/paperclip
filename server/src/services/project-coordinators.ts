import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, projects } from "@paperclipai/db";
import { getAgentWorkEligibility, isUuidLike } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";

export const PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV =
  "PAPERCLIP_PROJECT_COORDINATOR_TEMPLATE_AGENT_ID";

export interface ProjectCoordinatorMetadata {
  projectId: string;
  templateAgentId: string;
}

export interface ProjectCoordinatorActivityActor {
  actorType: LogActivityInput["actorType"];
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
  responsibleUserIdOverride?: string | null;
}

export interface ProjectCoordinatorIdentity {
  id: string;
  companyId: string;
  name: string;
  role: string;
  reportsTo: string | null;
  adapterType: "process";
}

export interface ProjectCoordinatorProjectIdentity {
  id: string;
  companyId: string;
  name: string;
  leadAgentId: string;
}

export interface ProjectCoordinatorProvisionResult {
  project: ProjectCoordinatorProjectIdentity;
  coordinator: ProjectCoordinatorIdentity;
  templateAgentId: string;
  created: boolean;
}

type AgentRow = typeof agents.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type CoordinatorIdentityAgent = Pick<
  AgentRow,
  "id" | "companyId" | "name" | "role" | "reportsTo" | "adapterType"
>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readProjectCoordinatorMetadata(metadata: unknown): ProjectCoordinatorMetadata | null {
  if (!isPlainRecord(metadata)) return null;
  const marker = metadata.projectCoordinator;
  if (!isPlainRecord(marker)) return null;
  const projectId = readNonEmptyString(marker.projectId);
  const templateAgentId = readNonEmptyString(marker.templateAgentId);
  if (!projectId || !templateAgentId) return null;
  return { projectId, templateAgentId };
}

export function isProjectCoordinatorAgentForProject(metadata: unknown, projectId: string): boolean {
  return readProjectCoordinatorMetadata(metadata)?.projectId === projectId;
}

export function configuredProjectCoordinatorTemplateAgentId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return readNonEmptyString(env[PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV]);
}

function templateConfigurationError(message: string, details?: Record<string, unknown>) {
  return unprocessable(message, {
    code: "project_coordinator_template_invalid",
    env: PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV,
    ...details,
  });
}

function provisionerActor(actor?: ProjectCoordinatorActivityActor): ProjectCoordinatorActivityActor {
  return actor ?? {
    actorType: "system",
    actorId: "project-coordinator-provisioner",
  };
}

function coordinatorIdentity(agent: CoordinatorIdentityAgent): ProjectCoordinatorIdentity {
  if (agent.adapterType !== "process") {
    throw conflict("Project coordinator identity must use the process adapter.", {
      code: "project_coordinator_identity_invalid",
      coordinatorAgentId: agent.id,
      adapterType: agent.adapterType,
    });
  }
  return {
    id: agent.id,
    companyId: agent.companyId,
    name: agent.name,
    role: agent.role,
    reportsTo: agent.reportsTo,
    adapterType: "process",
  };
}

function projectIdentity(project: ProjectRow, leadAgentId: string): ProjectCoordinatorProjectIdentity {
  return {
    id: project.id,
    companyId: project.companyId,
    name: project.name,
    leadAgentId,
  };
}

async function requireUsableTemplate(
  db: Db,
  companyId: string,
  templateAgentId: string,
): Promise<AgentRow> {
  if (!isUuidLike(templateAgentId)) {
    throw templateConfigurationError(
      `${PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV} must contain a valid agent ID.`,
      { templateAgentId },
    );
  }

  const template = await db
    .select()
    .from(agents)
    .where(eq(agents.id, templateAgentId))
    .then((rows) => rows[0] ?? null);
  if (!template) {
    throw templateConfigurationError("The configured project coordinator template agent does not exist.", {
      templateAgentId,
    });
  }
  if (template.companyId !== companyId) {
    throw templateConfigurationError(
      "The configured project coordinator template agent must belong to the project company.",
      { templateAgentId, companyId },
    );
  }
  if (template.adapterType !== "process") {
    throw templateConfigurationError(
      "The configured project coordinator template agent must use the process adapter.",
      { templateAgentId, adapterType: template.adapterType },
    );
  }

  const adapterConfig = isPlainRecord(template.adapterConfig) ? template.adapterConfig : null;
  if (!adapterConfig || !readNonEmptyString(adapterConfig.command)) {
    throw templateConfigurationError(
      "The configured project coordinator template agent needs a process command.",
      { templateAgentId },
    );
  }

  const companyAgents = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const eligibility = getAgentWorkEligibility({
    agent: {
      id: template.id,
      companyId: template.companyId,
      name: template.name,
      status: template.status,
      reportsTo: template.reportsTo,
    },
    agents: companyAgents,
  });
  if (!eligibility.invokable) {
    throw templateConfigurationError(
      "The configured project coordinator template agent is not usable for execution.",
      {
        templateAgentId,
        status: template.status,
        reason: eligibility.invokabilityReason,
      },
    );
  }

  return template;
}

function buildCoordinatorAdapterConfig(template: AgentRow, projectId: string): Record<string, unknown> {
  const adapterConfig = isPlainRecord(template.adapterConfig) ? { ...template.adapterConfig } : {};
  const env = isPlainRecord(adapterConfig.env) ? { ...adapterConfig.env } : {};
  return {
    ...adapterConfig,
    env: {
      ...env,
      PAPERCLIP_COORDINATOR_PROJECT_ID: {
        type: "plain",
        value: projectId,
      },
    },
  };
}

function buildCoordinatorRuntimeConfig(template: AgentRow): Record<string, unknown> {
  const runtimeConfig = isPlainRecord(template.runtimeConfig) ? { ...template.runtimeConfig } : {};
  const heartbeat = isPlainRecord(runtimeConfig.heartbeat) ? { ...runtimeConfig.heartbeat } : {};
  return {
    ...runtimeConfig,
    heartbeat: {
      ...heartbeat,
      maxConcurrentRuns: 1,
    },
  };
}

async function logCoordinatorProvisioned(
  db: Db,
  input: {
    actor?: ProjectCoordinatorActivityActor;
    project: ProjectRow;
    coordinator: ProjectCoordinatorIdentity;
    templateAgentId: string;
    created: boolean;
  },
) {
  const actor = provisionerActor(input.actor);
  if (input.created) {
    await logActivity(db, {
      companyId: input.project.companyId,
      ...actor,
      action: "agent.created",
      entityType: "agent",
      entityId: input.coordinator.id,
      details: {
        name: input.coordinator.name,
        role: input.coordinator.role,
        source: "project_coordinator",
        projectId: input.project.id,
        templateAgentId: input.templateAgentId,
      },
    });
  }
  await logActivity(db, {
    companyId: input.project.companyId,
    ...actor,
    action: "project.coordinator_provisioned",
    entityType: "project",
    entityId: input.project.id,
    details: {
      coordinatorAgentId: input.coordinator.id,
      templateAgentId: input.templateAgentId,
      created: input.created,
    },
  });
}

async function createCoordinator(
  db: Db,
  input: {
    project: ProjectRow;
    template: AgentRow;
    actor?: ProjectCoordinatorActivityActor;
  },
): Promise<ProjectCoordinatorProvisionResult> {
  const name = `Astra - ${input.project.name}`;
  const created = await agentService(db).create(input.project.companyId, {
    name,
    role: input.template.role,
    title: input.template.title,
    icon: input.template.icon,
    status: "idle",
    reportsTo: input.template.reportsTo,
    capabilities: input.template.capabilities,
    adapterType: "process",
    adapterConfig: buildCoordinatorAdapterConfig(input.template, input.project.id),
    runtimeConfig: buildCoordinatorRuntimeConfig(input.template),
    defaultEnvironmentId: input.template.defaultEnvironmentId,
    budgetMonthlyCents: input.template.budgetMonthlyCents,
    spentMonthlyCents: 0,
    permissions: normalizeAgentPermissions(input.template.permissions, { context: "stored" }),
    metadata: {
      projectCoordinator: {
        projectId: input.project.id,
        templateAgentId: input.template.id,
      },
    },
  });

  if (created.name !== name) {
    throw conflict(`An active agent already uses the required project coordinator name '${name}'.`, {
      code: "project_coordinator_name_conflict",
      projectId: input.project.id,
    });
  }

  const updatedProject = await db
    .update(projects)
    .set({ leadAgentId: created.id, updatedAt: new Date() })
    .where(and(eq(projects.id, input.project.id), eq(projects.companyId, input.project.companyId)))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!updatedProject) throw notFound("Project not found");

  const identity = coordinatorIdentity(created);
  await logCoordinatorProvisioned(db, {
    actor: input.actor,
    project: updatedProject,
    coordinator: identity,
    templateAgentId: input.template.id,
    created: true,
  });

  return {
    project: projectIdentity(updatedProject, created.id),
    coordinator: identity,
    templateAgentId: input.template.id,
    created: true,
  };
}

async function listProjectCoordinators(db: Db, companyId: string, projectId: string): Promise<AgentRow[]> {
  const companyAgents = await db.select().from(agents).where(eq(agents.companyId, companyId));
  return companyAgents.filter((agent) => isProjectCoordinatorAgentForProject(agent.metadata, projectId));
}

async function adoptExistingCoordinator(
  db: Db,
  input: {
    project: ProjectRow;
    coordinator: AgentRow;
    templateAgentId: string;
    actor?: ProjectCoordinatorActivityActor;
  },
): Promise<ProjectCoordinatorProvisionResult> {
  const updatedProject = await db
    .update(projects)
    .set({ leadAgentId: input.coordinator.id, updatedAt: new Date() })
    .where(and(eq(projects.id, input.project.id), eq(projects.companyId, input.project.companyId)))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!updatedProject) throw notFound("Project not found");

  const identity = coordinatorIdentity(input.coordinator);
  await logCoordinatorProvisioned(db, {
    actor: input.actor,
    project: updatedProject,
    coordinator: identity,
    templateAgentId: input.templateAgentId,
    created: false,
  });
  return {
    project: projectIdentity(updatedProject, input.coordinator.id),
    coordinator: identity,
    templateAgentId: input.templateAgentId,
    created: false,
  };
}

function alternativeLeadConflict(project: ProjectRow) {
  return conflict("Project already has a different lead agent; refusing to replace it.", {
    code: "project_coordinator_lead_conflict",
    projectId: project.id,
    leadAgentId: project.leadAgentId,
  });
}

export function projectCoordinatorService(db: Db) {
  return {
    provisionForNewProject: async (input: {
      project: ProjectRow;
      actor?: ProjectCoordinatorActivityActor;
    }): Promise<ProjectCoordinatorProvisionResult | null> => {
      const templateAgentId = configuredProjectCoordinatorTemplateAgentId();
      if (!templateAgentId) return null;

      // Any non-template lead is an explicit alternative. It is preserved even
      // when the operator's template setting is stale or malformed.
      if (input.project.leadAgentId && input.project.leadAgentId !== templateAgentId) {
        return null;
      }

      const existing = await listProjectCoordinators(db, input.project.companyId, input.project.id);
      if (existing.length > 1) {
        throw conflict("Project has multiple dedicated coordinator identities.", {
          code: "project_coordinator_duplicate",
          projectId: input.project.id,
        });
      }
      if (existing[0]) {
        const marker = readProjectCoordinatorMetadata(existing[0].metadata)!;
        return adoptExistingCoordinator(db, {
          project: input.project,
          coordinator: existing[0],
          templateAgentId: marker.templateAgentId,
          actor: input.actor,
        });
      }

      const template = await requireUsableTemplate(db, input.project.companyId, templateAgentId);
      return createCoordinator(db, { project: input.project, template, actor: input.actor });
    },

    provisionExistingProject: async (input: {
      projectId: string;
      companyId: string;
      actor?: ProjectCoordinatorActivityActor;
    }): Promise<ProjectCoordinatorProvisionResult> => {
      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const project = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!project) throw notFound("Project not found");

        const existing = await listProjectCoordinators(txDb, project.companyId, project.id);
        if (existing.length > 1) {
          throw conflict("Project has multiple dedicated coordinator identities.", {
            code: "project_coordinator_duplicate",
            projectId: project.id,
          });
        }
        if (existing[0]) {
          const marker = readProjectCoordinatorMetadata(existing[0].metadata)!;
          if (project.leadAgentId === existing[0].id) {
            return {
              project: projectIdentity(project, existing[0].id),
              coordinator: coordinatorIdentity(existing[0]),
              templateAgentId: marker.templateAgentId,
              created: false,
            };
          }
          if (project.leadAgentId && project.leadAgentId !== marker.templateAgentId) {
            throw alternativeLeadConflict(project);
          }
          return adoptExistingCoordinator(txDb, {
            project,
            coordinator: existing[0],
            templateAgentId: marker.templateAgentId,
            actor: input.actor,
          });
        }

        const templateAgentId = configuredProjectCoordinatorTemplateAgentId();
        if (!templateAgentId) {
          throw unprocessable(
            `${PROJECT_COORDINATOR_TEMPLATE_AGENT_ID_ENV} is not configured.`,
            { code: "project_coordinator_template_not_configured" },
          );
        }
        if (project.leadAgentId && project.leadAgentId !== templateAgentId) {
          throw alternativeLeadConflict(project);
        }

        const template = await requireUsableTemplate(txDb, project.companyId, templateAgentId);
        return createCoordinator(txDb, { project, template, actor: input.actor });
      });
    },
  };
}
