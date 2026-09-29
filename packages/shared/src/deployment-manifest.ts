import { z } from "zod";
import { createCompanySchema } from "./validators/company.js";
import { createAgentSchema } from "./validators/agent.js";
import { createProjectSchema, createProjectWorkspaceSchema } from "./validators/project.js";
import { createRoutineSchema, createRoutineTriggerSchema } from "./validators/routine.js";

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const identity = z.object({ adopt: z.string().uuid().optional() });
const company = identity.extend({
  fields: createCompanySchema.pick({ name: true, description: true, budgetMonthlyCents: true }).strict(),
}).strict();
const project = identity.extend({
  company: key,
  fields: createProjectSchema.pick({ name: true, description: true, executionWorkspacePolicy: true }).strict(),
}).strict();
const agent = identity.extend({
  company: key,
  enabled: z.boolean().default(true),
  reportsTo: key.nullable().default(null),
  fields: createAgentSchema.pick({
    name: true, role: true, title: true, capabilities: true,
    adapterType: true, adapterConfig: true, budgetMonthlyCents: true, permissions: true,
  }).strict(),
  // Values are names in the runtime credential map, never secret values or paths.
  credentials: z.record(z.string().regex(/^(env\.[A-Z_][A-Z0-9_]*|[a-zA-Z][a-zA-Z0-9]*)$/), key).default({}),
}).strict();
const routine = identity.extend({
  company: key,
  project: key,
  agent: key,
  enabled: z.boolean().default(true),
  fields: createRoutineSchema.pick({
    title: true, description: true, priority: true, concurrencyPolicy: true,
    catchUpPolicy: true,
  }).strict(),
  schedule: createRoutineTriggerSchema.options[0].omit({ enabled: true }).extend({
    adopt: z.string().uuid().optional(),
  }).strict(),
}).strict();

/** Deployment v1 deliberately reuses the native validators for owned fields. */
export const deploymentManifestSchema = z.object({
  version: z.literal(1),
  owner: key,
  companies: z.record(key, company),
  projects: z.record(key, project).default({}),
  projectWorkspaces: z.record(key, identity.extend({
    project: key,
    fields: createProjectWorkspaceSchema.strict(),
  }).strict()).default({}),
  agents: z.record(key, agent).default({}),
  routines: z.record(key, routine).default({}),
  taskBridges: z.record(key, z.object({
    agent: key, project: key, credential: key,
    allowedAssignees: z.array(key).min(1).max(50),
  }).strict()).default({}),
}).strict().superRefine((m, ctx) => {
  const issue = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const primaries = new Map<string, number>();
  for (const [name, workspace] of Object.entries(m.projectWorkspaces)) {
    if (!m.projects[workspace.project]) issue(["projectWorkspaces", name, "project"], "Unknown project key");
    primaries.set(workspace.project, (primaries.get(workspace.project) ?? 0) + Number(workspace.fields.isPrimary));
  }
  for (const [project, count] of primaries) {
    if (count !== 1) issue(["projectWorkspaces"], `Project ${project} requires exactly one declared primary workspace`);
  }
  for (const [name, project] of Object.entries(m.projects)) {
    for (const field of ["defaultProjectWorkspaceId", "environmentId"] as const) {
      if (project.fields.executionWorkspacePolicy?.[field] != null) {
        issue(["projects", name, "fields", "executionWorkspacePolicy", field], "Deployment policies cannot reference unmanaged database IDs; use the project primary workspace");
      }
    }
  }
  for (const kind of ["projects", "agents", "routines"] as const) {
    for (const [name, resource] of Object.entries(m[kind])) {
      if (!m.companies[resource.company]) issue([kind, name, "company"], "Unknown company key");
    }
  }
  for (const [name, a] of Object.entries(m.agents)) {
    const seen = new Set([name]);
    let manager = a.reportsTo;
    while (manager) {
      if (seen.has(manager)) { issue(["agents", name, "reportsTo"], "Reporting cycle"); break; }
      seen.add(manager);
      const parent = m.agents[manager];
      if (!parent || parent.company !== a.company) {
        issue(["agents", name, "reportsTo"], "Manager must be a declared agent in the same company"); break;
      }
      manager = parent.reportsTo;
    }
  }
  for (const [name, r] of Object.entries(m.routines)) {
    if (m.projects[r.project]?.company !== r.company) issue(["routines", name, "project"], "Project must belong to the same company");
    if (m.agents[r.agent]?.company !== r.company) issue(["routines", name, "agent"], "Agent must belong to the same company");
  }
  for (const [name, bridge] of Object.entries(m.taskBridges)) {
    const company = m.agents[bridge.agent]?.company;
    if (!company || m.projects[bridge.project]?.company !== company
      || bridge.allowedAssignees.some((a) => m.agents[a]?.company !== company)) {
      issue(["taskBridges", name], "Bridge references must resolve within one declared company");
    }
  }
});

export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
