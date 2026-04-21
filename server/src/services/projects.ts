import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  projects,
  projectGoals,
  goals,
  labels,
  projectLabels,
  projectWorkspaces,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  PROJECT_COLORS,
  deriveProjectUrlKey,
  hasNonAsciiContent,
  isValidProjectCode,
  isUuidLike,
  normalizeProjectCode,
  normalizeProjectUrlKey,
  type ProjectCodebase,
  type ProjectExecutionWorkspacePolicy,
  type ProjectGoalRef,
  type ProjectWorkspaceRuntimeConfig,
  type ProjectWorkspace,
  type WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { listCurrentRuntimeServicesForProjectWorkspaces } from "./workspace-runtime-read-model.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { mergeProjectWorkspaceRuntimeConfig, readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";

type ProjectRow = typeof projects.$inferSelect;
type ProjectLabelRow = typeof labels.$inferSelect;
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
type CreateWorkspaceInput = {
  name?: string | null;
  sourceType?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  defaultRef?: string | null;
  visibility?: string | null;
  setupCommand?: string | null;
  cleanupCommand?: string | null;
  remoteProvider?: string | null;
  remoteWorkspaceRef?: string | null;
  sharedWorkspaceKey?: string | null;
  metadata?: Record<string, unknown> | null;
  runtimeConfig?: Partial<ProjectWorkspaceRuntimeConfig> | null;
  isPrimary?: boolean;
};
type UpdateWorkspaceInput = Partial<CreateWorkspaceInput>;
type DuplicateProjectOptions = {
  name?: string | null;
};

interface ProjectWithGoals extends Omit<ProjectRow, "executionWorkspacePolicy"> {
  urlKey: string;
  goalIds: string[];
  goals: ProjectGoalRef[];
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  labels: ProjectLabelRow[];
  labelIds: string[];
  codebase: ProjectCodebase;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

interface ProjectShortnameRow {
  id: string;
  name: string;
}

interface ResolveProjectNameOptions {
  excludeProjectId?: string | null;
}

/** Batch-load goal refs for a set of projects. */
async function attachGoals(db: Db, rows: ProjectRow[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);

  // Fetch join rows + goal titles in one query
  const links = await db
    .select({
      projectId: projectGoals.projectId,
      goalId: projectGoals.goalId,
      goalTitle: goals.title,
    })
    .from(projectGoals)
    .innerJoin(goals, eq(projectGoals.goalId, goals.id))
    .where(inArray(projectGoals.projectId, projectIds));

  const map = new Map<string, ProjectGoalRef[]>();
  for (const link of links) {
    let arr = map.get(link.projectId);
    if (!arr) {
      arr = [];
      map.set(link.projectId, arr);
    }
    arr.push({ id: link.goalId, title: link.goalTitle });
  }

  return rows.map((r) => {
    const g = map.get(r.id) ?? [];
    return {
      ...r,
      urlKey: deriveProjectUrlKey(r.name, r.id),
      goalIds: g.map((x) => x.id),
      goals: g,
      executionWorkspacePolicy: parseProjectExecutionWorkspacePolicy(r.executionWorkspacePolicy),
      labels: [],
      labelIds: [],
      codebase: deriveProjectCodebase({
        companyId: r.companyId,
        projectId: r.id,
        primaryWorkspace: null,
        fallbackWorkspaces: [],
      }),
      workspaces: [],
      primaryWorkspace: null,
    } as ProjectWithGoals;
  });
}

async function labelMapForProjects(dbOrTx: any, projectIds: string[]): Promise<Map<string, ProjectLabelRow[]>> {
  const map = new Map<string, ProjectLabelRow[]>();
  if (projectIds.length === 0) return map;
  const rows = await dbOrTx
    .select({
      projectId: projectLabels.projectId,
      label: labels,
    })
    .from(projectLabels)
    .innerJoin(labels, eq(projectLabels.labelId, labels.id))
    .where(inArray(projectLabels.projectId, projectIds))
    .orderBy(asc(labels.name), asc(labels.id));

  for (const row of rows) {
    const existing = map.get(row.projectId);
    if (existing) existing.push(row.label);
    else map.set(row.projectId, [row.label]);
  }
  return map;
}

async function attachLabels(dbOrTx: any, rows: ProjectWithGoals[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];
  const labelsByProjectId = await labelMapForProjects(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const projectLabelRows = labelsByProjectId.get(row.id) ?? [];
    return {
      ...row,
      labels: projectLabelRows,
      labelIds: projectLabelRows.map((label) => label.id),
    };
  });
}

function toRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: row.url ?? null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorkspace(
  row: ProjectWorkspaceRow,
  runtimeServices: WorkspaceRuntimeService[] = [],
): ProjectWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    name: row.name,
    sourceType: row.sourceType as ProjectWorkspace["sourceType"],
    cwd: normalizeWorkspaceCwd(row.cwd),
    repoUrl: row.repoUrl ?? null,
    repoRef: row.repoRef ?? null,
    defaultRef: row.defaultRef ?? row.repoRef ?? null,
    visibility: row.visibility as ProjectWorkspace["visibility"],
    setupCommand: row.setupCommand ?? null,
    cleanupCommand: row.cleanupCommand ?? null,
    remoteProvider: row.remoteProvider ?? null,
    remoteWorkspaceRef: row.remoteWorkspaceRef ?? null,
    sharedWorkspaceKey: row.sharedWorkspaceKey ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    runtimeConfig: readProjectWorkspaceRuntimeConfig((row.metadata as Record<string, unknown> | null) ?? null),
    isPrimary: row.isPrimary,
    runtimeServices,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const raw = readNonEmptyString(repoUrl);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

function deriveProjectCodebase(input: {
  companyId: string;
  projectId: string;
  primaryWorkspace: ProjectWorkspace | null;
  fallbackWorkspaces: ProjectWorkspace[];
}): ProjectCodebase {
  const primaryWorkspace = input.primaryWorkspace ?? input.fallbackWorkspaces[0] ?? null;
  const repoUrl = primaryWorkspace?.repoUrl ?? null;
  const repoName = deriveRepoNameFromRepoUrl(repoUrl);
  const localFolder = primaryWorkspace?.cwd ?? null;
  const managedFolder = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName,
  });

  return {
    workspaceId: primaryWorkspace?.id ?? null,
    repoUrl,
    repoRef: primaryWorkspace?.repoRef ?? null,
    defaultRef: primaryWorkspace?.defaultRef ?? null,
    repoName,
    localFolder,
    managedFolder,
    effectiveLocalFolder: localFolder ?? managedFolder,
    origin: localFolder ? "local_folder" : "managed_checkout",
  };
}

function pickPrimaryWorkspace(
  rows: ProjectWorkspaceRow[],
  runtimeServicesByWorkspaceId?: Map<string, WorkspaceRuntimeService[]>,
): ProjectWorkspace | null {
  if (rows.length === 0) return null;
  const explicitPrimary = rows.find((row) => row.isPrimary);
  const primary = explicitPrimary ?? rows[0];
  return toWorkspace(primary, runtimeServicesByWorkspaceId?.get(primary.id) ?? []);
}

/** Batch-load workspace refs for a set of projects. */
async function attachWorkspaces(db: Db, rows: ProjectWithGoals[]): Promise<ProjectWithGoals[]> {
  if (rows.length === 0) return [];

  const projectIds = rows.map((r) => r.id);
  const workspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(inArray(projectWorkspaces.projectId, projectIds))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
  const runtimeServicesByWorkspaceId = await listCurrentRuntimeServicesForProjectWorkspaces(
    db,
    rows[0]!.companyId,
    workspaceRows.map((workspace) => workspace.id),
  );
  const sharedRuntimeServicesByWorkspaceId = new Map(
    Array.from(runtimeServicesByWorkspaceId.entries()).map(([workspaceId, services]) => [
      workspaceId,
      services.map(toRuntimeService),
    ]),
  );

  const map = new Map<string, ProjectWorkspaceRow[]>();
  for (const row of workspaceRows) {
    let arr = map.get(row.projectId);
    if (!arr) {
      arr = [];
      map.set(row.projectId, arr);
    }
    arr.push(row);
  }

  return rows.map((row) => {
    const projectWorkspaceRows = map.get(row.id) ?? [];
    const workspaces = projectWorkspaceRows.map((workspace) =>
      toWorkspace(
        workspace,
        sharedRuntimeServicesByWorkspaceId.get(workspace.id) ?? [],
      ),
    );
    const primaryWorkspace = pickPrimaryWorkspace(projectWorkspaceRows, sharedRuntimeServicesByWorkspaceId);
    return {
      ...row,
      codebase: deriveProjectCodebase({
        companyId: row.companyId,
        projectId: row.id,
        primaryWorkspace,
        fallbackWorkspaces: workspaces,
      }),
      workspaces,
      primaryWorkspace,
    };
  });
}

/** Sync the project_goals join table for a single project. */
async function syncGoalLinks(db: Db, projectId: string, companyId: string, goalIds: string[]) {
  // Delete existing links
  await db.delete(projectGoals).where(eq(projectGoals.projectId, projectId));

  // Insert new links
  if (goalIds.length > 0) {
    await db.insert(projectGoals).values(
      goalIds.map((goalId) => ({ projectId, goalId, companyId })),
    );
  }
}

async function assertValidProjectLabelIds(companyId: string, labelIds: string[], dbOrTx: any) {
  if (labelIds.length === 0) return;
  const existing = await dbOrTx
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
  if (existing.length !== new Set(labelIds).size) {
    throw unprocessable("One or more labels are invalid for this company");
  }
}

async function syncProjectLabels(
  projectId: string,
  companyId: string,
  labelIds: string[],
  dbOrTx: any,
) {
  const deduped = [...new Set(labelIds)];
  await assertValidProjectLabelIds(companyId, deduped, dbOrTx);
  await dbOrTx.delete(projectLabels).where(eq(projectLabels.projectId, projectId));
  if (deduped.length === 0) return;
  await dbOrTx.insert(projectLabels).values(
    deduped.map((labelId) => ({
      projectId,
      labelId,
      companyId,
    })),
  );
}

async function assertValidProjectParent(
  dbOrTx: any,
  input: {
    companyId: string;
    projectId?: string | null;
    parentId?: string | null;
  },
) {
  if (input.parentId === undefined || input.parentId === null) return;
  if (input.projectId && input.parentId === input.projectId) {
    throw unprocessable("Project cannot be its own parent");
  }

  const seen = new Set<string>();
  let cursor: string | null = input.parentId;
  while (cursor) {
    if (input.projectId && cursor === input.projectId) {
      throw unprocessable("Project cannot use one of its descendants as parent");
    }
    if (seen.has(cursor)) {
      throw unprocessable("Project parent hierarchy contains a cycle");
    }
    seen.add(cursor);

    const parent: { id: string; companyId: string; parentId: string | null } | null = await dbOrTx
      .select({ id: projects.id, companyId: projects.companyId, parentId: projects.parentId })
      .from(projects)
      .where(eq(projects.id, cursor))
      .then((rows: Array<{ id: string; companyId: string; parentId: string | null }>) => rows[0] ?? null);

    if (!parent || parent.companyId !== input.companyId) {
      throw unprocessable("Parent project must belong to the same company");
    }
    cursor = parent.parentId;
  }
}

function normalizeProjectCodeForPersistence(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const code = normalizeProjectCode(value);
  if (code === null) return null;
  if (!isValidProjectCode(code)) {
    throw unprocessable("Project code can only contain A-Z and 0-9 and must be 16 characters or fewer");
  }
  return code;
}

async function assertProjectCodeAvailable(
  dbOrTx: any,
  input: {
    companyId: string;
    code: string | null | undefined;
    projectId?: string | null;
  },
) {
  if (!input.code) return;
  const existing = await dbOrTx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, input.companyId), eq(projects.code, input.code)))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  if (existing && existing.id !== input.projectId) {
    throw conflict(`Project code ${input.code} is already used in this company`);
  }
}

/** Resolve goalIds from input, handling the legacy goalId field. */
function resolveGoalIds(data: { goalIds?: string[]; goalId?: string | null }): string[] | undefined {
  if (data.goalIds !== undefined) return data.goalIds;
  if (data.goalId !== undefined) {
    return data.goalId ? [data.goalId] : [];
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceCwd(value: unknown): string | null {
  const cwd = readNonEmptyString(value);
  if (!cwd) return null;
  return cwd === REPO_ONLY_CWD_SENTINEL ? null : cwd;
}

function duplicateProjectExecutionWorkspacePolicy(
  policy: Record<string, unknown> | null | undefined,
  workspaceIdMap: Map<string, string>,
): Record<string, unknown> | null {
  if (!policy) return null;
  const defaultWorkspaceId =
    typeof policy.defaultProjectWorkspaceId === "string" ? policy.defaultProjectWorkspaceId : null;
  if (!defaultWorkspaceId) return { ...policy };
  return {
    ...policy,
    defaultProjectWorkspaceId: workspaceIdMap.get(defaultWorkspaceId) ?? null,
  };
}

function deriveNameFromCwd(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Local folder";
}

function deriveNameFromRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    const cleanedPath = url.pathname.replace(/\/+$/, "");
    const lastSegment = cleanedPath.split("/").filter(Boolean).pop() ?? "";
    const noGitSuffix = lastSegment.replace(/\.git$/i, "");
    return noGitSuffix || repoUrl;
  } catch {
    return repoUrl;
  }
}

function deriveWorkspaceName(input: {
  name?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
}) {
  const explicit = readNonEmptyString(input.name);
  if (explicit) return explicit;

  const cwd = readNonEmptyString(input.cwd);
  if (cwd) return deriveNameFromCwd(cwd);

  const repoUrl = readNonEmptyString(input.repoUrl);
  if (repoUrl) return deriveNameFromRepoUrl(repoUrl);

  return "Workspace";
}

export function resolveProjectNameForUniqueShortname(
  requestedName: string,
  existingProjects: ProjectShortnameRow[],
  options?: ResolveProjectNameOptions,
): string {
  const requestedShortname = normalizeProjectUrlKey(requestedName);
  if (!requestedShortname) return requestedName;
  // Non-ASCII names get a UUID suffix in deriveProjectUrlKey, making slugs inherently unique.
  if (hasNonAsciiContent(requestedName)) return requestedName;

  const usedShortnames = new Set(
    existingProjects
      .filter((project) => !(options?.excludeProjectId && project.id === options.excludeProjectId))
      .map((project) => normalizeProjectUrlKey(project.name))
      .filter((value): value is string => value !== null),
  );
  if (!usedShortnames.has(requestedShortname)) return requestedName;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidateName = `${requestedName} ${suffix}`;
    const candidateShortname = normalizeProjectUrlKey(candidateName);
    if (candidateShortname && !usedShortnames.has(candidateShortname)) {
      return candidateName;
    }
  }

  // Fallback guard for pathological naming collisions.
  return `${requestedName} ${Date.now()}`;
}

async function ensureSinglePrimaryWorkspace(
  dbOrTx: any,
  input: {
    companyId: string;
    projectId: string;
    keepWorkspaceId: string;
  },
) {
  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
      ),
    );

  await dbOrTx
    .update(projectWorkspaces)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(
      and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, input.projectId),
        eq(projectWorkspaces.id, input.keepWorkspaceId),
      ),
    );
}

export function projectService(db: Db) {
  return {
    list: async (companyId: string): Promise<ProjectWithGoals[]> => {
      const rows = await db.select().from(projects).where(eq(projects.companyId, companyId));
      const withGoals = await attachGoals(db, rows);
      const withLabels = await attachLabels(db, withGoals);
      return attachWorkspaces(db, withLabels);
    },

    listByIds: async (companyId: string, ids: string[]): Promise<ProjectWithGoals[]> => {
      const dedupedIds = [...new Set(ids)];
      if (dedupedIds.length === 0) return [];
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, dedupedIds)));
      const withGoals = await attachGoals(db, rows);
      const withLabels = await attachLabels(db, withGoals);
      const withWorkspaces = await attachWorkspaces(db, withLabels);
      const byId = new Map(withWorkspaces.map((project) => [project.id, project]));
      return dedupedIds.map((id) => byId.get(id)).filter((project): project is ProjectWithGoals => Boolean(project));
    },

    getById: async (id: string): Promise<ProjectWithGoals | null> => {
      const row = await db
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [withGoals] = await attachGoals(db, [row]);
      if (!withGoals) return null;
      const [withLabels] = await attachLabels(db, [withGoals]);
      const [enriched] = withLabels ? await attachWorkspaces(db, [withLabels]) : [];
      return enriched ?? null;
    },

    create: async (
      companyId: string,
      data: Omit<typeof projects.$inferInsert, "companyId"> & { goalIds?: string[]; labelIds?: string[] },
    ): Promise<ProjectWithGoals> => {
      const { goalIds: inputGoalIds, labelIds: inputLabelIds, ...projectData } = data;
      const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });
      await assertValidProjectLabelIds(companyId, inputLabelIds ?? [], db);

      // Auto-assign a color from the palette if none provided
      if (!projectData.color) {
        const existing = await db.select({ color: projects.color }).from(projects).where(eq(projects.companyId, companyId));
        const usedColors = new Set(existing.map((r) => r.color).filter(Boolean));
        const nextColor = PROJECT_COLORS.find((c) => !usedColors.has(c)) ?? PROJECT_COLORS[existing.length % PROJECT_COLORS.length];
        projectData.color = nextColor;
      }

      const existingProjects = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects);
      const normalizedCode = normalizeProjectCodeForPersistence(projectData.code);
      if (normalizedCode !== undefined) projectData.code = normalizedCode;
      await assertProjectCodeAvailable(db, {
        companyId,
        code: projectData.code,
        projectId: projectData.id ?? null,
      });
      await assertValidProjectParent(db, {
        companyId,
        projectId: projectData.id ?? null,
        parentId: projectData.parentId,
      });

      // Also write goalId to the legacy column (first goal or null)
      const legacyGoalId = ids && ids.length > 0 ? ids[0] : projectData.goalId ?? null;

      const row = await db
        .insert(projects)
        .values({ ...projectData, goalId: legacyGoalId, companyId })
        .returning()
        .then((rows) => rows[0]);

      if (ids && ids.length > 0) {
        await syncGoalLinks(db, row.id, companyId, ids);
      }
      if (inputLabelIds !== undefined) {
        await syncProjectLabels(row.id, companyId, inputLabelIds, db);
      }

      const [withGoals] = await attachGoals(db, [row]);
      const [withLabels] = withGoals ? await attachLabels(db, [withGoals]) : [];
      const [enriched] = withLabels ? await attachWorkspaces(db, [withLabels]) : [];
      return enriched!;
    },

    duplicate: async (
      id: string,
      options: DuplicateProjectOptions = {},
    ): Promise<ProjectWithGoals | null> => {
      const source = await db
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0] ?? null);
      if (!source) return null;

      const [
        sourceGoalLinks,
        sourceLabelLinks,
        sourceWorkspaceRows,
        existingProjects,
      ] = await Promise.all([
        db
          .select({ goalId: projectGoals.goalId })
          .from(projectGoals)
          .where(eq(projectGoals.projectId, id)),
        db
          .select({ labelId: projectLabels.labelId })
          .from(projectLabels)
          .where(eq(projectLabels.projectId, id)),
        db
          .select()
          .from(projectWorkspaces)
          .where(eq(projectWorkspaces.projectId, id))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id)),
        db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.companyId, source.companyId)),
      ]);

      const requestedName = readNonEmptyString(options.name) ?? `${source.name} Copy`;
      const duplicateName = resolveProjectNameForUniqueShortname(requestedName, existingProjects);
      const primarySourceWorkspaceId = sourceWorkspaceRows.find((workspace) => workspace.isPrimary)?.id
        ?? sourceWorkspaceRows[0]?.id
        ?? null;

      const createdRow = await db.transaction(async (tx) => {
        const row = await tx
          .insert(projects)
          .values({
            companyId: source.companyId,
            parentId: source.parentId,
            goalId: source.goalId,
            name: duplicateName,
            description: source.description,
            status: "planned",
            leadAgentId: source.leadAgentId,
            targetDate: source.targetDate,
            color: source.color,
            env: source.env,
            executionWorkspacePolicy: duplicateProjectExecutionWorkspacePolicy(
              source.executionWorkspacePolicy,
              new Map(),
            ),
            archivedAt: null,
            pauseReason: null,
            pausedAt: null,
          })
          .returning()
          .then((rows) => rows[0]!);

        if (sourceGoalLinks.length > 0) {
          await tx.insert(projectGoals).values(
            sourceGoalLinks.map((link) => ({
              companyId: source.companyId,
              projectId: row.id,
              goalId: link.goalId,
            })),
          );
        }

        if (sourceLabelLinks.length > 0) {
          await tx.insert(projectLabels).values(
            sourceLabelLinks.map((link) => ({
              companyId: source.companyId,
              projectId: row.id,
              labelId: link.labelId,
            })),
          );
        }

        const workspaceIdMap = new Map<string, string>();
        for (const workspace of sourceWorkspaceRows) {
          const copiedWorkspace = await tx
            .insert(projectWorkspaces)
            .values({
              companyId: source.companyId,
              projectId: row.id,
              name: workspace.name,
              sourceType: workspace.sourceType,
              cwd: workspace.cwd,
              repoUrl: workspace.repoUrl,
              repoRef: workspace.repoRef,
              defaultRef: workspace.defaultRef,
              visibility: workspace.visibility,
              setupCommand: workspace.setupCommand,
              cleanupCommand: workspace.cleanupCommand,
              remoteProvider: workspace.remoteProvider,
              remoteWorkspaceRef: workspace.remoteWorkspaceRef,
              sharedWorkspaceKey: workspace.sharedWorkspaceKey,
              metadata: workspace.metadata,
              isPrimary: workspace.id === primarySourceWorkspaceId,
            })
            .returning({ id: projectWorkspaces.id })
            .then((rows) => rows[0] ?? null);
          if (copiedWorkspace) workspaceIdMap.set(workspace.id, copiedWorkspace.id);
        }

        if (!source.executionWorkspacePolicy) return row;

        return tx
          .update(projects)
          .set({
            executionWorkspacePolicy: duplicateProjectExecutionWorkspacePolicy(
              source.executionWorkspacePolicy,
              workspaceIdMap,
            ),
            updatedAt: new Date(),
          })
          .where(eq(projects.id, row.id))
          .returning()
          .then((rows) => rows[0] ?? row);
      });

      const [withGoals] = await attachGoals(db, [createdRow]);
      const [withLabels] = withGoals ? await attachLabels(db, [withGoals]) : [];
      const [enriched] = withLabels ? await attachWorkspaces(db, [withLabels]) : [];
      return enriched ?? null;
    },

    update: async (
      id: string,
      data: Partial<typeof projects.$inferInsert> & { goalIds?: string[]; labelIds?: string[] },
    ): Promise<ProjectWithGoals | null> => {
      const { goalIds: inputGoalIds, labelIds: inputLabelIds, ...projectData } = data;
      const ids = resolveGoalIds({ goalIds: inputGoalIds, goalId: projectData.goalId });
      const existingProject = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name, parentId: projects.parentId })
        .from(projects)
        .where(eq(projects.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existingProject) return null;
      await assertValidProjectLabelIds(existingProject.companyId, inputLabelIds ?? [], db);
      await assertValidProjectParent(db, {
        companyId: existingProject.companyId,
        projectId: existingProject.id,
        parentId: projectData.parentId,
      });

      if (projectData.name !== undefined) {
        const existingShortname = normalizeProjectUrlKey(existingProject.name);
        const nextShortname = normalizeProjectUrlKey(projectData.name);
        if (existingShortname !== nextShortname) {
          const existingProjects = await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(eq(projects.companyId, existingProject.companyId));
          projectData.name = resolveProjectNameForUniqueShortname(projectData.name, existingProjects, {
            excludeProjectId: id,
          });
        }
      }
      const normalizedCode = normalizeProjectCodeForPersistence(projectData.code);
      if (normalizedCode !== undefined) {
        projectData.code = normalizedCode;
        await assertProjectCodeAvailable(db, {
          companyId: existingProject.companyId,
          code: normalizedCode,
          projectId: existingProject.id,
        });
      }

      // Keep legacy goalId column in sync
      const updates: Partial<typeof projects.$inferInsert> = {
        ...projectData,
        updatedAt: new Date(),
      };
      if (ids !== undefined) {
        updates.goalId = ids.length > 0 ? ids[0] : null;
      }

      const row = await db
        .update(projects)
        .set(updates)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      if (ids !== undefined) {
        await syncGoalLinks(db, id, row.companyId, ids);
      }
      if (inputLabelIds !== undefined) {
        await syncProjectLabels(id, row.companyId, inputLabelIds, db);
      }

      const [withGoals] = await attachGoals(db, [row]);
      const [withLabels] = withGoals ? await attachLabels(db, [withGoals]) : [];
      const [enriched] = withLabels ? await attachWorkspaces(db, [withLabels]) : [];
      return enriched ?? null;
    },

    remove: (id: string) =>
      db
        .delete(projects)
        .where(eq(projects.id, id))
        .returning()
        .then((rows) => {
          const row = rows[0] ?? null;
          if (!row) return null;
          return { ...row, urlKey: deriveProjectUrlKey(row.name, row.id) };
        }),

    listWorkspaces: async (projectId: string): Promise<ProjectWorkspace[]> => {
      const rows = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
      if (rows.length === 0) return [];
      const runtimeServicesByWorkspaceId = await listCurrentRuntimeServicesForProjectWorkspaces(
        db,
        rows[0]!.companyId,
        rows.map((workspace) => workspace.id),
      );
      return rows.map((row) =>
        toWorkspace(
          row,
          (runtimeServicesByWorkspaceId.get(row.id) ?? []).map(toRuntimeService),
        ),
      );
    },

    createWorkspace: async (
      projectId: string,
      data: CreateWorkspaceInput,
    ): Promise<ProjectWorkspace | null> => {
      const project = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) return null;

      const cwd = normalizeWorkspaceCwd(data.cwd);
      const repoUrl = readNonEmptyString(data.repoUrl);
      const sourceType = readNonEmptyString(data.sourceType) ?? (repoUrl ? "git_repo" : cwd ? "local_path" : "remote_managed");
      const remoteWorkspaceRef = readNonEmptyString(data.remoteWorkspaceRef);
      if (sourceType === "remote_managed") {
        if (!remoteWorkspaceRef && !repoUrl) return null;
      } else if (!cwd && !repoUrl) {
        return null;
      }
      const name = deriveWorkspaceName({
        name: data.name,
        cwd,
        repoUrl,
      });

      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.projectId, projectId))
        .orderBy(asc(projectWorkspaces.createdAt))
        .then((rows) => rows);

      const shouldBePrimary = data.isPrimary === true || existing.length === 0;
      const created = await db.transaction(async (tx) => {
        if (shouldBePrimary) {
          await tx
            .update(projectWorkspaces)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(projectWorkspaces.companyId, project.companyId),
                eq(projectWorkspaces.projectId, projectId),
              ),
            );
        }

        const row = await tx
          .insert(projectWorkspaces)
          .values({
            companyId: project.companyId,
            projectId,
            name,
            sourceType,
            cwd: cwd ?? null,
            repoUrl: repoUrl ?? null,
            repoRef: readNonEmptyString(data.repoRef),
            defaultRef: readNonEmptyString(data.defaultRef) ?? readNonEmptyString(data.repoRef),
            visibility: readNonEmptyString(data.visibility) ?? "default",
            setupCommand: readNonEmptyString(data.setupCommand),
            cleanupCommand: readNonEmptyString(data.cleanupCommand),
            remoteProvider: readNonEmptyString(data.remoteProvider),
            remoteWorkspaceRef,
            sharedWorkspaceKey: readNonEmptyString(data.sharedWorkspaceKey),
            metadata:
              data.runtimeConfig !== undefined
                ? mergeProjectWorkspaceRuntimeConfig(
                    (data.metadata as Record<string, unknown> | null | undefined) ?? null,
                    data.runtimeConfig ?? null,
                  )
                : (data.metadata as Record<string, unknown> | null | undefined) ?? null,
            isPrimary: shouldBePrimary,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
        return row;
      });

      return created ? toWorkspace(created) : null;
    },

    updateWorkspace: async (
      projectId: string,
      workspaceId: string,
      data: UpdateWorkspaceInput,
    ): Promise<ProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const nextCwd =
        data.cwd !== undefined
          ? normalizeWorkspaceCwd(data.cwd)
          : normalizeWorkspaceCwd(existing.cwd);
      const nextRepoUrl =
        data.repoUrl !== undefined
          ? readNonEmptyString(data.repoUrl)
          : readNonEmptyString(existing.repoUrl);
      const nextSourceType =
        data.sourceType !== undefined
          ? readNonEmptyString(data.sourceType)
          : readNonEmptyString(existing.sourceType);
      const nextRemoteWorkspaceRef =
        data.remoteWorkspaceRef !== undefined
          ? readNonEmptyString(data.remoteWorkspaceRef)
          : readNonEmptyString(existing.remoteWorkspaceRef);
      if (nextSourceType === "remote_managed") {
        if (!nextRemoteWorkspaceRef && !nextRepoUrl) return null;
      } else if (!nextCwd && !nextRepoUrl) {
        return null;
      }

      const patch: Partial<typeof projectWorkspaces.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (data.name !== undefined) patch.name = deriveWorkspaceName({ name: data.name, cwd: nextCwd, repoUrl: nextRepoUrl });
      if (data.name === undefined && (data.cwd !== undefined || data.repoUrl !== undefined)) {
        patch.name = deriveWorkspaceName({ cwd: nextCwd, repoUrl: nextRepoUrl });
      }
      if (data.cwd !== undefined) patch.cwd = nextCwd ?? null;
      if (data.repoUrl !== undefined) patch.repoUrl = nextRepoUrl ?? null;
      if (data.repoRef !== undefined) patch.repoRef = readNonEmptyString(data.repoRef);
      if (data.sourceType !== undefined && nextSourceType) patch.sourceType = nextSourceType;
      if (data.defaultRef !== undefined) patch.defaultRef = readNonEmptyString(data.defaultRef);
      if (data.visibility !== undefined && readNonEmptyString(data.visibility)) {
        patch.visibility = readNonEmptyString(data.visibility)!;
      }
      if (data.setupCommand !== undefined) patch.setupCommand = readNonEmptyString(data.setupCommand);
      if (data.cleanupCommand !== undefined) patch.cleanupCommand = readNonEmptyString(data.cleanupCommand);
      if (data.remoteProvider !== undefined) patch.remoteProvider = readNonEmptyString(data.remoteProvider);
      if (data.remoteWorkspaceRef !== undefined) patch.remoteWorkspaceRef = nextRemoteWorkspaceRef;
      if (data.sharedWorkspaceKey !== undefined) patch.sharedWorkspaceKey = readNonEmptyString(data.sharedWorkspaceKey);
      if (data.metadata !== undefined || data.runtimeConfig !== undefined) {
        patch.metadata =
          data.runtimeConfig !== undefined
            ? mergeProjectWorkspaceRuntimeConfig(
                data.metadata !== undefined
                  ? (data.metadata as Record<string, unknown> | null | undefined)
                  : ((existing.metadata as Record<string, unknown> | null | undefined) ?? null),
                data.runtimeConfig ?? null,
              )
            : data.metadata;
      }

      const updated = await db.transaction(async (tx) => {
        if (data.isPrimary === true) {
          await tx
            .update(projectWorkspaces)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(projectWorkspaces.companyId, existing.companyId),
                eq(projectWorkspaces.projectId, projectId),
              ),
            );
          patch.isPrimary = true;
        } else if (data.isPrimary === false) {
          patch.isPrimary = false;
        }

        const row = await tx
          .update(projectWorkspaces)
          .set(patch)
          .where(eq(projectWorkspaces.id, workspaceId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;

        if (row.isPrimary) return row;

        const hasPrimary = await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, row.companyId),
              eq(projectWorkspaces.projectId, row.projectId),
              eq(projectWorkspaces.isPrimary, true),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (!hasPrimary) {
          const nextPrimaryCandidate = await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, row.companyId),
                eq(projectWorkspaces.projectId, row.projectId),
                eq(projectWorkspaces.id, row.id),
              ),
            )
            .then((rows) => rows[0] ?? null);
          const alternateCandidate = await tx
            .select({ id: projectWorkspaces.id })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, row.companyId),
                eq(projectWorkspaces.projectId, row.projectId),
              ),
            )
            .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
            .then((rows) => rows.find((candidate) => candidate.id !== row.id) ?? null);

          await ensureSinglePrimaryWorkspace(tx, {
            companyId: row.companyId,
            projectId: row.projectId,
            keepWorkspaceId: alternateCandidate?.id ?? nextPrimaryCandidate?.id ?? row.id,
          });
          const refreshed = await tx
            .select()
            .from(projectWorkspaces)
            .where(eq(projectWorkspaces.id, row.id))
            .then((rows) => rows[0] ?? row);
          return refreshed;
        }

        return row;
      });

      return updated ? toWorkspace(updated) : null;
    },

    removeWorkspace: async (projectId: string, workspaceId: string): Promise<ProjectWorkspace | null> => {
      const existing = await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.id, workspaceId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const removed = await db.transaction(async (tx) => {
        const row = await tx
          .delete(projectWorkspaces)
          .where(eq(projectWorkspaces.id, workspaceId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!row) return null;

        if (!row.isPrimary) return row;

        const next = await tx
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, row.companyId),
              eq(projectWorkspaces.projectId, row.projectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (next) {
          await ensureSinglePrimaryWorkspace(tx, {
            companyId: row.companyId,
            projectId: row.projectId,
            keepWorkspaceId: next.id,
          });
        }

        return row;
      });

      return removed ? toWorkspace(removed) : null;
    },

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { project: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const row = await db
          .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
          .from(projects)
          .where(and(eq(projects.id, raw), eq(projects.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!row) return { project: null, ambiguous: false } as const;
        return {
          project: { id: row.id, companyId: row.companyId, urlKey: deriveProjectUrlKey(row.name, row.id) },
          ambiguous: false,
        } as const;
      }

      const urlKey = normalizeProjectUrlKey(raw);
      if (!urlKey) {
        return { project: null, ambiguous: false } as const;
      }

      const rows = await db
        .select({ id: projects.id, companyId: projects.companyId, name: projects.name })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      const matches = rows.filter((row) => deriveProjectUrlKey(row.name, row.id) === urlKey);
      if (matches.length === 1) {
        const match = matches[0]!;
        return {
          project: { id: match.id, companyId: match.companyId, urlKey: deriveProjectUrlKey(match.name, match.id) },
          ambiguous: false,
        } as const;
      }
      if (matches.length > 1) {
        return { project: null, ambiguous: true } as const;
      }
      return { project: null, ambiguous: false } as const;
    },
  };
}
