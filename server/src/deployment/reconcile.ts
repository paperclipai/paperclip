import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  type Db, deploymentResources, companies, projects, agents, routines,
  routineTriggers, agentApiKeys, companySecrets, companySecretVersions, companyMemberships,
  pluginManagedResources, builtInManagedResources,
  instanceSettings, projectWorkspaces,
} from "@paperclipai/db";
import { deploymentManifestSchema, type DeploymentManifest } from "@paperclipai/shared";
import { companyService } from "../services/companies.js";
import { projectService } from "../services/projects.js";
import { agentService } from "../services/agents.js";
import { routineService } from "../services/routines.js";
import { secretService } from "../services/secrets.js";
import { stableJson } from "../services/managed-resource-drift.js";
import { logActivity } from "../services/activity-log.js";
import { validateDeclaredAdapterConfig } from "./adapter-config.js";
import { validateCron } from "../services/cron.js";
import { bootstrapOperator } from "./bootstrap.js";
import { readCredential, type DeploymentDescriptor } from "./runtime.js";
import type { Config } from "../config.js";
import { verifyLocalEncryptedMaterials } from "../secrets/local-encrypted-provider.js";
import { mergeProjectWorkspaceRuntimeConfig } from "../services/project-workspace-runtime-config.js";

const tables = { company: companies, project: projects, workspace: projectWorkspaces, agent: agents, routine: routines, schedule: routineTriggers, secret: companySecrets, taskBridge: agentApiKeys };
type Kind = keyof typeof tables;
type Binding = typeof deploymentResources.$inferSelect;
type Fields = Record<string, unknown>;
type Spec = { kind: Kind; key: string; id: string; companyId: string | null; adopt?: string; enabled: boolean; fields: () => Fields; create: (fields: Fields) => Promise<string>; update: (fields: Fields) => Promise<unknown> };
export type DeploymentDifference = { kind: string; key: string; action: "create" | "adopt" | "update" | "disable"; fields: string[] };

/** Values never appear in plans, including adapter URLs, paths and credentials. */
export function changedFields(before: Fields, after: Fields): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter((k) => stableJson(before[k]) !== stableJson(after[k]));
}

async function validateAdapters(manifest: DeploymentManifest, credentials: Record<string, string>) {
  for (const a of Object.values(manifest.agents)) {
    validateDeclaredAdapterConfig(a.fields.adapterType, a.fields.adapterConfig, a.credentials);
    for (const credential of Object.values(a.credentials)) {
      if (!credentials[credential]) throw new Error("Missing declared worker credential");
    }
  }
  for (const r of Object.values(manifest.routines)) {
    if (validateCron(r.schedule.cronExpression)) throw new Error("Invalid declared routine schedule");
    try { new Intl.DateTimeFormat("en", { timeZone: r.schedule.timezone }); }
    catch { throw new Error("Invalid declared routine timezone"); }
  }
}

/** One process-local reconciler for startup, plan, apply and check. No HTTP bypass. */
export async function reconcileDeployment(db: Db, raw: unknown, options: {
  apply: boolean; descriptor: DeploymentDescriptor; config: Config; singleOwner: boolean;
}) {
  const parsed = deploymentManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid deployment manifest or references");
  const m = parsed.data;
  const credentials = Object.fromEntries(Object.entries(options.descriptor.credentialFiles).map(([key, file]) => [key, readCredential(file)]));
  await validateAdapters(m, credentials);
  for (const b of Object.values(m.taskBridges)) {
    if (!credentials[b.credential] || credentials[b.credential].trim().length < 32) throw new Error("Task bridge requires a runtime token of at least 32 characters");
  }
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    if (!options.apply) await tx.execute(sql`set transaction read only`);
    // Serialize all owners, including adoption across different manifests.
    await tx.execute(sql`select pg_advisory_xact_lock(1735289201)`);
    if (options.apply) await tx.execute(sql`select set_config('paperclip.deployment_apply', 'on', true)`);
    const [identity] = await tx.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "deployment"));
    if (identity && identity.general.instance !== options.descriptor.instance) throw new Error("Database belongs to another deployment instance");
    if (options.singleOwner && identity?.general.owner && identity.general.owner !== m.owner) {
      throw new Error("Deployment owner changed; an explicit ownership handoff is required");
    }
    // Validate historical and unmanaged local secrets too: the instance key is
    // shared, and a no-op declaration must not mask a broken restore/rotation.
    const encrypted = await tx.select({ material: companySecretVersions.material }).from(companySecretVersions)
      .innerJoin(companySecrets, eq(companySecretVersions.secretId, companySecrets.id))
      .where(eq(companySecrets.provider, "local_encrypted"));
    const keyFile = options.descriptor.serverCredentials.encryption ?? options.config.secretsMasterKeyFilePath;
    if (encrypted.length || options.descriptor.serverCredentials.encryption || existsSync(keyFile)) {
      verifyLocalEncryptedMaterials(readCredential(keyFile), encrypted.map((v) => v.material));
    }
    const ledger = await tx.select().from(deploymentResources);
    if (options.singleOwner && ledger.some((binding) => binding.owner !== m.owner)) {
      throw new Error("Deployment owner changed; an explicit ownership handoff is required");
    }
    const owned = ledger.filter((b) => b.owner === m.owner);
    if (options.apply && (Object.keys(m.projectWorkspaces).length || owned.some((b) => b.kind === "workspace"))) {
      // Native primary selection updates sibling rows. Prevent a UI/API writer
      // from inserting or changing a sibling between ownership validation and apply.
      await tx.execute(sql`lock table project_workspaces in share row exclusive mode`);
    }
    const bindings = new Map(owned.map((b) => [`${b.kind}/${b.key}`, b]));
    const ids = new Map<string, string>();
    const getId = (kind: Kind, key: string, adopt?: string) => {
      const identity = `${kind}/${key}`;
      const id = ids.get(identity) ?? bindings.get(identity)?.resourceId ?? adopt ?? randomUUID();
      ids.set(identity, id); return id;
    };
    for (const [key, c] of Object.entries(m.companies)) getId("company", key, c.adopt);
    for (const [key, p] of Object.entries(m.projects)) getId("project", key, p.adopt);
    for (const [key, w] of Object.entries(m.projectWorkspaces)) getId("workspace", key, w.adopt);
    for (const [key, a] of Object.entries(m.agents)) getId("agent", key, a.adopt);
    const actorId = await bootstrapOperator(tx, options.config, options.descriptor.bootstrap, false);
    if (Object.keys(m.routines).length && !actorId && !options.descriptor.bootstrap) throw new Error("Declared routines require an operator bootstrap identity");
    const actor = { userId: actorId };
    const companySvc = companyService(tx), projectSvc = projectService(tx), agentSvc = agentService(tx), routineSvc = routineService(tx), secrets = secretService(tx);
    const specs: Spec[] = [];
    const add = (spec: Omit<Spec, "id">) => specs.push({ ...spec, id: getId(spec.kind, spec.key, spec.adopt) });
    for (const [key, c] of Object.entries(m.companies).sort()) {
      add({ kind: "company", key, adopt: c.adopt, companyId: null, enabled: true, fields: () => c.fields,
        create: async (f) => (await companySvc.create({ ...c.fields, ...f, id: getId("company", key), defaultResponsibleUserId: actor.userId }, { provisionBundledAgents: false })).id,
        update: (f) => companySvc.update(getId("company", key), f) });
    }
    for (const [key, p] of Object.entries(m.projects).sort()) {
      const companyId = getId("company", p.company);
      add({ kind: "project", key, adopt: p.adopt, companyId, enabled: true, fields: () => ({ ...p.fields, companyId }),
        create: async () => (await projectSvc.create(companyId, { ...p.fields, id: getId("project", key) })).id,
        update: (f) => projectSvc.update(getId("project", key), f) });
    }
    // Native services auto-select the first workspace and repair missing primaries.
    // Apply the declared primary first so those repairs never choose a different row.
    const workspaceEntries = Object.entries(m.projectWorkspaces).sort(([a, x], [b, y]) =>
      Number(y.fields.isPrimary) - Number(x.fields.isPrimary) || a.localeCompare(b));
    for (const [key, w] of workspaceEntries) {
      const companyId = getId("company", m.projects[w.project].company);
      const projectId = getId("project", w.project);
      const { runtimeConfig, ...nativeFields } = w.fields;
      const fields = {
        ...nativeFields,
        sourceType: nativeFields.sourceType ?? (nativeFields.repoUrl ? "git_repo" : "local_path"),
        ...(runtimeConfig !== undefined ? { metadata: mergeProjectWorkspaceRuntimeConfig(nativeFields.metadata ?? null, runtimeConfig) } : {}),
        companyId, projectId,
      };
      add({ kind: "workspace", key, adopt: w.adopt, companyId, enabled: true, fields: () => fields,
        create: async () => {
          const created = await projectSvc.createWorkspace(projectId, fields);
          if (!created) throw new Error("Declared workspace could not be created");
          return created.id;
        },
        update: async () => {
          if (!await projectSvc.updateWorkspace(projectId, getId("workspace", key), fields)) throw new Error("Declared workspace could not be updated");
        } });
    }
    const agentKeys: string[] = [];
    const visit = (key: string) => { if (agentKeys.includes(key)) return; const parent = m.agents[key].reportsTo; if (parent) visit(parent); agentKeys.push(key); };
    Object.keys(m.agents).sort().forEach(visit);
    for (const key of agentKeys) {
      const a = m.agents[key], companyId = getId("company", a.company);
      for (const [field, credential] of Object.entries(a.credentials).sort()) {
        const secretKey = `${key}.${field}`;
        const value = credentials[credential];
        // A digest is private database bookkeeping, never exported in a plan.
        // Runtime sources are expected to contain high-entropy worker keys.
        const digest = createHash("sha256").update(value).digest("hex");
        add({ kind: "secret", key: secretKey, companyId, enabled: true, fields: () => ({ digest }),
          create: async () => (await secrets.create(companyId, { name: `deployment.${m.owner}.${secretKey}`, provider: "local_encrypted", value })).id,
          update: () => secrets.rotate(getId("secret", secretKey), { value }) });
      }
      const fields = () => {
        const adapterConfig = { ...a.fields.adapterConfig };
        for (const field of Object.keys(a.credentials)) {
          const ref = { type: "secret_ref", secretId: getId("secret", `${key}.${field}`), version: "latest" };
          if (field.startsWith("env.")) adapterConfig.env = { ...(adapterConfig.env as Fields ?? {}), [field.slice(4)]: ref };
          else adapterConfig[field] = ref;
        }
        return { ...a.fields, adapterConfig, reportsTo: a.reportsTo ? getId("agent", a.reportsTo) : null, companyId };
      };
      add({ kind: "agent", key, adopt: a.adopt, companyId, enabled: a.enabled, fields,
        create: async (f) => (await agentSvc.create(companyId, { ...a.fields, ...f, id: getId("agent", key), status: a.enabled ? "idle" : "paused" })).id,
        update: (f) => agentSvc.update(getId("agent", key), f) });
    }
    for (const [key, r] of Object.entries(m.routines).sort()) {
      const companyId = getId("company", r.company);
      const { adopt: scheduleAdopt, ...schedule } = r.schedule;
      const fields = () => ({ ...r.fields, projectId: getId("project", r.project), assigneeAgentId: getId("agent", r.agent), companyId });
      add({ kind: "routine", key, adopt: r.adopt, companyId, enabled: r.enabled, fields,
        create: async () => (await routineSvc.create(companyId, { ...r.fields, projectId: getId("project", r.project), assigneeAgentId: getId("agent", r.agent), status: r.enabled ? "active" : "paused", variables: [] }, actor)).id,
        update: (f) => routineSvc.update(getId("routine", key), f, actor) });
      add({ kind: "schedule", key, adopt: scheduleAdopt, companyId, enabled: true, fields: () => ({ ...schedule, routineId: getId("routine", key) }),
        create: async () => (await routineSvc.createTrigger(getId("routine", key), { ...schedule, enabled: true }, actor)).trigger.id,
        update: () => routineSvc.updateTrigger(getId("schedule", key), schedule, actor) });
    }
    for (const [key, b] of Object.entries(m.taskBridges).sort()) {
      const companyId = getId("company", m.agents[b.agent].company);
      const token = credentials[b.credential].trimEnd();
      const scope = { kind: "task_bridge" as const, projectId: getId("project", b.project), allowedAssigneeAgentIds: b.allowedAssignees.map((a) => getId("agent", a)).sort() };
      add({ kind: "taskBridge", key, companyId, enabled: true,
        fields: () => ({ agentId: getId("agent", b.agent), scopeConfig: scope, keyHash: createHash("sha256").update(token).digest("hex") }),
        create: async () => (await agentSvc.createApiKey(getId("agent", b.agent), `deployment.${m.owner}.${key}`, scope, { responsibleUserId: actor.userId, token })).id,
        update: async () => { throw new Error("Task bridge rotation requires a new declaration key and removal of the old key"); } });
    }
    const differences: DeploymentDifference[] = [];
    if (!identity) differences.push({ kind: "instance", key: options.descriptor.instance, action: "create", fields: ["instance"] });
    else if (options.singleOwner && !identity.general.owner) {
      differences.push({ kind: "instance", key: options.descriptor.instance, action: "update", fields: ["owner"] });
    }
    const actions = new Map<Spec, DeploymentDifference>();
    const claimed = new Set<string>();
    // Read and validate ALL existing identities before the first application write.
    for (const spec of specs) {
      const resource = `${spec.kind}/${spec.id}`;
      if (claimed.has(resource)) throw new Error("Duplicate resource ownership in deployment manifest");
      claimed.add(resource);
      const binding = bindings.get(`${spec.kind}/${spec.key}`);
      if (spec.adopt && binding && spec.adopt !== binding.resourceId) throw new Error("Adoption cannot change a managed identity");
      if (binding && binding.companyId !== spec.companyId) throw new Error("Moving managed resources between companies is unsupported");
      if (binding && !binding.enabled && ["taskBridge", "secret"].includes(spec.kind)) throw new Error("Removed credentials require a new declaration key");
      if (ledger.some((b) => b.kind === spec.kind && b.resourceId === spec.id && (b.owner !== m.owner || b.key !== spec.key))) throw new Error("Resource ownership conflict");
      const table = tables[spec.kind];
      const existing = await tx.select({ id: table.id }).from(table).where(eq(table.id, spec.id));
      if ((binding || spec.adopt) && !existing.length) throw new Error("Managed or adopted resource is missing; explicit recovery is required");
      if (spec.kind === "workspace") {
        const projectId = spec.fields().projectId as string;
        const siblings = await tx.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, projectId));
        if (existing.length) {
          const [workspace] = await tx.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, spec.id));
          if (workspace.projectId !== projectId || workspace.companyId !== spec.companyId) throw new Error("Workspace belongs to a different project or company");
        } else if (siblings.some((workspace) =>
          (spec.fields().name && workspace.name === String(spec.fields().name).trim()) ||
          (spec.fields().remoteWorkspaceRef && workspace.remoteWorkspaceRef === spec.fields().remoteWorkspaceRef
            && workspace.remoteProvider === (spec.fields().remoteProvider ?? null)))) {
          throw new Error("Existing workspace requires explicit adoption");
        }
        if (spec.fields().isPrimary && siblings.some((workspace) => workspace.isPrimary && workspace.id !== spec.id
          && !specs.some((other) => other.kind === "workspace" && other.id === workspace.id && other.fields().projectId === projectId))) {
          throw new Error("Existing primary workspace requires explicit adoption before changing primary selection");
        }
      }
      if (!binding && !spec.adopt && existing.length) throw new Error("Existing unmanaged resource requires explicit adoption");
      if (spec.adopt) {
        for (const registry of [pluginManagedResources, builtInManagedResources]) {
          const owners = await tx.select({ id: registry.id }).from(registry).where(eq(registry.resourceId, spec.id));
          if (owners.length) throw new Error("Adoption conflicts with an existing managed resource owner");
        }
      }
      if (!binding && !spec.adopt && ["company", "project", "agent", "routine"].includes(spec.kind)) {
        const fields = spec.fields();
        const label = spec.kind === "routine" ? "title" : "name";
        const matches = await tx.execute(sql`select id from ${table} where ${sql.identifier(label)} = ${fields[label] as string}
          ${spec.companyId ? sql`and company_id = ${spec.companyId}` : sql``} limit 1`);
        if (matches.length) throw new Error("Existing resource with this name requires explicit adoption");
      }
      if (spec.kind === "taskBridge" && !binding) {
        const matches = await tx.select({ id: agentApiKeys.id }).from(agentApiKeys).where(eq(agentApiKeys.keyHash, spec.fields().keyHash as string));
        if (matches.length) throw new Error("Task bridge tokens must be unique; use a new runtime token");
      }
      if (spec.adopt && spec.companyId) {
        const rows = await tx.execute(sql`select company_id from ${table} where id = ${spec.id}`);
        if (rows[0]?.company_id !== spec.companyId) throw new Error("Adopted resource belongs to a different company");
      }
      if (spec.kind === "schedule") {
        const routineId = spec.fields().routineId as string;
        if (existing.length) {
          const [trigger] = await tx.select({ routineId: routineTriggers.routineId, kind: routineTriggers.kind })
            .from(routineTriggers).where(eq(routineTriggers.id, spec.id));
          if (!trigger || trigger.routineId !== routineId || trigger.kind !== "schedule") {
            throw new Error("Adopted schedule must belong to the declared routine");
          }
        }
        if (!binding) {
          const active = await tx.select({ id: routineTriggers.id }).from(routineTriggers).where(and(
            eq(routineTriggers.routineId, routineId), eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true), eq(routineTriggers.archived, false),
          ));
          if (active.some((trigger) => trigger.id !== (spec.adopt ?? ""))) {
            throw new Error("Existing active schedule requires explicit adoption before declaring this routine");
          }
        }
      }
      const changed = changedFields(binding?.fields ?? {}, spec.fields());
      if (binding && spec.kind === "taskBridge" && changed.length) throw new Error("Task bridge rotation requires a new declaration key and removal of the old key");
      if (!binding || changed.length || binding.enabled !== spec.enabled) {
        const action: DeploymentDifference = { kind: spec.kind, key: spec.key, action: !binding ? (spec.adopt ? "adopt" : "create") : "update", fields: changed };
        actions.set(spec, action); differences.push(action);
      }
    }
    const removed = owned.filter((b) => b.enabled && !specs.some((s) => s.kind === b.kind && s.key === b.key));
    if (removed.some((b) => b.kind === "workspace")) throw new Error("Workspace removal requires an explicit ownership handoff; retain the declaration to preserve execution references");
    for (const b of removed) differences.push({ kind: b.kind, key: b.key, action: "disable", fields: [] });
    if (options.descriptor.bootstrap && !actorId) differences.unshift({ kind: "operator", key: "bootstrap", action: "create", fields: [] });
    if (options.apply) {
      if (!identity) await tx.insert(instanceSettings).values({ singletonKey: "deployment", general: {
        instance: options.descriptor.instance, ...(options.singleOwner ? { owner: m.owner } : {}),
      } });
      else if (options.singleOwner && !identity.general.owner) {
        await tx.update(instanceSettings).set({ general: { ...identity.general, owner: m.owner } })
          .where(eq(instanceSettings.id, identity.id));
      }
      actor.userId = await bootstrapOperator(tx, options.config, options.descriptor.bootstrap, true);
      for (const spec of specs) {
        if (!actions.has(spec)) continue;
        const fields = spec.fields();
        const binding = bindings.get(`${spec.kind}/${spec.key}`);
        if (!binding && !spec.adopt) {
          spec.id = await spec.create(fields); ids.set(`${spec.kind}/${spec.key}`, spec.id);
        } else await spec.update(fields);
        if (!spec.enabled) await disableResource(tx, spec.kind, spec.id);
        const next = { owner: m.owner, kind: spec.kind, key: spec.key, resourceId: spec.id, companyId: spec.companyId, fields: spec.fields(), enabled: spec.enabled };
        await tx.insert(deploymentResources).values(next).onConflictDoUpdate({ target: [deploymentResources.owner, deploymentResources.kind, deploymentResources.key], set: next });
        const companyId = spec.companyId ?? spec.id;
        if (spec.kind === "company" && actor.userId && !binding) {
          await tx.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actor.userId, status: "active", membershipRole: "owner" }).onConflictDoNothing();
        }
        await logActivity(tx, { companyId, actorType: "system", actorId: `deployment:${m.owner}`, action: "deployment.reconciled", entityType: spec.kind, entityId: spec.id, details: { key: spec.key, fields: actions.get(spec)!.fields } });
      }
      for (const binding of removed) {
        await disableResource(tx, binding.kind as Kind, binding.resourceId);
        await tx.update(deploymentResources).set({ enabled: false }).where(and(eq(deploymentResources.owner, m.owner), eq(deploymentResources.kind, binding.kind), eq(deploymentResources.key, binding.key)));
        await logActivity(tx, { companyId: binding.companyId ?? binding.resourceId, actorType: "system", actorId: `deployment:${m.owner}`, action: "deployment.disabled", entityType: binding.kind, entityId: binding.resourceId, details: { key: binding.key } });
      }
    }
    return {
      version: 1, owner: m.owner, differences,
      bindings: Object.fromEntries(specs.filter((s) => options.apply || bindings.has(`${s.kind}/${s.key}`)).map((s) => [`${s.kind}/${s.key}`, s.id])),
    };
  });
}

async function disableResource(db: Db, kind: Kind, id: string) {
  if (kind === "agent") {
    await db.update(agents).set({ status: "paused" }).where(and(eq(agents.id, id), sql`${agents.status} not in ('paused', 'terminated')`));
  } else if (kind === "routine") {
    await db.update(routines).set({ status: "paused" }).where(eq(routines.id, id));
  } else if (kind === "company") {
    await db.update(companies).set({ status: "paused" }).where(and(eq(companies.id, id), eq(companies.status, "active")));
  } else if (kind === "taskBridge") {
    await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.id, id));
  } else if (kind === "schedule") {
    await db.update(routineTriggers).set({ enabled: false }).where(eq(routineTriggers.id, id));
  } else if (kind === "secret") {
    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, id));
  }
}
