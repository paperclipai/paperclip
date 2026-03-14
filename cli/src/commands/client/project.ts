import { Command } from "commander";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
  type Project,
  type ProjectWorkspace,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface ProjectListOptions extends BaseClientOptions {
  companyId?: string;
  status?: string;
  leadAgentId?: string;
  goalId?: string;
  match?: string;
}

interface ProjectCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  description?: string;
  status?: string;
  leadAgentId?: string;
  targetDate?: string;
  color?: string;
  goalId?: string;
  goalIds?: string;
  workspaceName?: string;
  workspaceCwd?: string;
  workspaceRepoUrl?: string;
  workspaceRepoRef?: string;
  workspacePrimary?: boolean;
}

interface ProjectUpdateOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  description?: string;
  status?: string;
  leadAgentId?: string;
  targetDate?: string;
  color?: string;
  goalId?: string;
  goalIds?: string;
  archivedAt?: string;
}

interface ProjectWorkspaceListOptions extends BaseClientOptions {
  companyId?: string;
}

interface ProjectWorkspaceCreateOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  cwd?: string;
  repoUrl?: string;
  repoRef?: string;
  primary?: boolean;
}

interface ProjectWorkspaceUpdateOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  cwd?: string;
  repoUrl?: string;
  repoRef?: string;
  primary?: boolean;
  notPrimary?: boolean;
}

interface ProjectWorkspaceDeleteOptions extends BaseClientOptions {
  companyId?: string;
  yes?: boolean;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function resolveGoalIds(input: { goalId?: string; goalIds?: string }): string[] | undefined {
  if (input.goalIds !== undefined) return parseCsv(input.goalIds);
  if (input.goalId === undefined) return undefined;
  const single = input.goalId.trim();
  return single ? [single] : [];
}

export function parseNullableCliValue(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "null") return null;
  return value;
}

function parseArchivedAt(value: string | undefined): string | null | undefined {
  return parseNullableCliValue(value);
}

function buildReferenceQuery(companyId?: string): string {
  return companyId?.trim() ? `?companyId=${encodeURIComponent(companyId.trim())}` : "";
}

function buildProjectPath(idOrRef: string, companyId?: string): string {
  return `/api/projects/${encodeURIComponent(idOrRef)}${buildReferenceQuery(companyId)}`;
}

function buildProjectWorkspacesPath(idOrRef: string, companyId?: string): string {
  return `/api/projects/${encodeURIComponent(idOrRef)}/workspaces${buildReferenceQuery(companyId)}`;
}

function buildProjectWorkspacePath(idOrRef: string, workspaceId: string, companyId?: string): string {
  return `/api/projects/${encodeURIComponent(idOrRef)}/workspaces/${encodeURIComponent(workspaceId)}${buildReferenceQuery(companyId)}`;
}

function buildWorkspaceInput(opts: ProjectCreateOptions) {
  const hasWorkspaceInput = Boolean(
    opts.workspaceName ||
      opts.workspaceCwd ||
      opts.workspaceRepoUrl ||
      opts.workspaceRepoRef ||
      opts.workspacePrimary,
  );
  if (!hasWorkspaceInput) return undefined;

  return {
    name: opts.workspaceName,
    cwd: opts.workspaceCwd,
    repoUrl: opts.workspaceRepoUrl,
    repoRef: opts.workspaceRepoRef,
    isPrimary: opts.workspacePrimary,
  };
}

function primaryWorkspaceLabel(project: Project): string | null {
  const workspace = project.primaryWorkspace;
  if (!workspace) return null;
  return workspace.cwd ?? workspace.repoUrl ?? workspace.name;
}

function workspaceLabel(workspace: ProjectWorkspace): string {
  return workspace.cwd ?? workspace.repoUrl ?? workspace.name;
}

function resolvePrimaryFlag(opts: { primary?: boolean; notPrimary?: boolean }): boolean | undefined {
  if (opts.primary && opts.notPrimary) {
    throw new Error("Choose either --primary or --not-primary, not both.");
  }
  if (opts.primary) return true;
  if (opts.notPrimary) return false;
  return undefined;
}

export function filterProjectRows(rows: Project[], opts: ProjectListOptions): Project[] {
  const statusFilters = new Set(parseCsv(opts.status).map((value) => value.toLowerCase()));
  const goalIdFilter = opts.goalId?.trim();
  const leadAgentIdFilter = opts.leadAgentId?.trim();
  const needle = opts.match?.trim().toLowerCase();

  return rows.filter((row) => {
    if (statusFilters.size > 0 && !statusFilters.has(row.status.toLowerCase())) {
      return false;
    }

    if (leadAgentIdFilter && row.leadAgentId !== leadAgentIdFilter) {
      return false;
    }

    if (goalIdFilter) {
      const goalIds = row.goalIds ?? [];
      const legacyGoalId = row.goalId ? [row.goalId] : [];
      if (![...goalIds, ...legacyGoalId].includes(goalIdFilter)) {
        return false;
      }
    }

    if (!needle) return true;

    const haystack = [
      row.id,
      row.urlKey,
      row.name,
      row.description,
      row.status,
      row.color,
      row.primaryWorkspace?.name,
      row.primaryWorkspace?.cwd,
      row.primaryWorkspace?.repoUrl,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .toLowerCase();

    return haystack.includes(needle);
  });
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project operations");
  const workspace = project.command("workspace").description("Project workspace operations");

  addCommonClientOptions(
    project
      .command("list")
      .description("List projects for a company")
      .option("--status <csv>", "Comma-separated statuses")
      .option("--lead-agent-id <id>", "Filter by lead agent ID")
      .option("--goal-id <id>", "Filter by goal ID")
      .option("--match <text>", "Local text match on id/url-key/name/description/workspace")
      .action(async (opts: ProjectListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Project[]>(`/api/companies/${ctx.companyId}/projects`)) ?? [];
          const filtered = filterProjectRows(rows, opts);

          if (ctx.json) {
            printOutput(filtered, { json: true });
            return;
          }

          if (filtered.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of filtered) {
            console.log(
              formatInlineRecord({
                id: row.id,
                urlKey: row.urlKey,
                status: row.status,
                name: row.name,
                leadAgentId: row.leadAgentId,
                goalCount: row.goalIds.length,
                primaryWorkspace: primaryWorkspaceLabel(row),
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    project
      .command("get")
      .description("Get a project by UUID or shortname/url-key")
      .argument("<idOrReference>", "Project ID or shortname/url-key")
      .action(async (idOrReference: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Project>(buildProjectPath(idOrReference, ctx.companyId));
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    project
      .command("create")
      .description("Create a project")
      .requiredOption("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      .option("--status <status>", "Project status")
      .option("--lead-agent-id <id>", "Lead agent ID")
      .option("--target-date <date>", "Target date")
      .option("--color <color>", "Project color hex")
      .option("--goal-id <id>", "Single goal ID (legacy shorthand)")
      .option("--goal-ids <csv>", "Comma-separated goal IDs")
      .option("--workspace-name <name>", "Optional primary workspace display name")
      .option("--workspace-cwd <path>", "Optional primary workspace local path")
      .option("--workspace-repo-url <url>", "Optional primary workspace repo URL")
      .option("--workspace-repo-ref <ref>", "Optional primary workspace repo ref")
      .option("--workspace-primary", "Mark the created workspace as primary")
      .action(async (opts: ProjectCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createProjectSchema.parse({
            name: opts.name,
            description: opts.description,
            status: opts.status,
            leadAgentId: opts.leadAgentId,
            targetDate: opts.targetDate,
            color: opts.color,
            goalIds: resolveGoalIds(opts),
            workspace: buildWorkspaceInput(opts),
          });

          const created = await ctx.api.post<Project>(`/api/companies/${ctx.companyId}/projects`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    project
      .command("update")
      .description("Update a project")
      .argument("<idOrReference>", "Project ID or shortname/url-key")
      .option("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      .option("--status <status>", "Project status")
      .option("--lead-agent-id <id>", "Lead agent ID")
      .option("--target-date <date>", "Target date")
      .option("--color <color>", "Project color hex")
      .option("--goal-id <id>", "Single goal ID (legacy shorthand)")
      .option("--goal-ids <csv>", "Comma-separated goal IDs")
      .option("--archived-at <iso8601|null>", "Set archivedAt timestamp or literal 'null'")
      .action(async (idOrReference: string, opts: ProjectUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateProjectSchema.parse({
            name: opts.name,
            description: opts.description,
            status: opts.status,
            leadAgentId: opts.leadAgentId,
            targetDate: opts.targetDate,
            color: opts.color,
            goalIds: resolveGoalIds(opts),
            archivedAt: parseArchivedAt(opts.archivedAt),
          });

          if (Object.keys(payload).length === 0) {
            throw new Error("At least one field is required to update a project.");
          }

          const updated = await ctx.api.patch<Project>(buildProjectPath(idOrReference, ctx.companyId), payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    workspace
      .command("list")
      .description("List workspaces for a project")
      .argument("<projectIdOrReference>", "Project ID or shortname/url-key")
      .action(async (projectIdOrReference: string, opts: ProjectWorkspaceListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<ProjectWorkspace[]>(
            buildProjectWorkspacesPath(projectIdOrReference, ctx.companyId),
          )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                name: row.name,
                isPrimary: row.isPrimary,
                workspace: workspaceLabel(row),
                repoRef: row.repoRef,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    workspace
      .command("add")
      .description("Add a workspace to a project")
      .argument("<projectIdOrReference>", "Project ID or shortname/url-key")
      .option("--name <name>", "Workspace display name")
      .option("--cwd <path>", "Local workspace path")
      .option("--repo-url <url>", "Repository URL")
      .option("--repo-ref <ref>", "Repository ref or branch")
      .option("--primary", "Mark this workspace as primary")
      .action(async (projectIdOrReference: string, opts: ProjectWorkspaceCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createProjectWorkspaceSchema.parse({
            name: opts.name,
            cwd: parseNullableCliValue(opts.cwd),
            repoUrl: parseNullableCliValue(opts.repoUrl),
            repoRef: parseNullableCliValue(opts.repoRef),
            isPrimary: Boolean(opts.primary),
          });

          const created = await ctx.api.post<ProjectWorkspace>(
            buildProjectWorkspacesPath(projectIdOrReference, ctx.companyId),
            payload,
          );
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    workspace
      .command("update")
      .description("Update an existing project workspace")
      .argument("<projectIdOrReference>", "Project ID or shortname/url-key")
      .argument("<workspaceId>", "Workspace ID")
      .option("--name <name>", "Workspace display name")
      .option("--cwd <path|null>", "Set local workspace path or literal 'null' to clear")
      .option("--repo-url <url|null>", "Set repo URL or literal 'null' to clear")
      .option("--repo-ref <ref|null>", "Set repo ref or literal 'null' to clear")
      .option("--primary", "Mark this workspace as primary")
      .option("--not-primary", "Mark this workspace as not primary")
      .action(async (
        projectIdOrReference: string,
        workspaceId: string,
        opts: ProjectWorkspaceUpdateOptions,
      ) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateProjectWorkspaceSchema.parse({
            name: opts.name,
            cwd: parseNullableCliValue(opts.cwd),
            repoUrl: parseNullableCliValue(opts.repoUrl),
            repoRef: parseNullableCliValue(opts.repoRef),
            isPrimary: resolvePrimaryFlag(opts),
          });

          if (Object.keys(payload).length === 0) {
            throw new Error("At least one field is required to update a project workspace.");
          }

          const updated = await ctx.api.patch<ProjectWorkspace>(
            buildProjectWorkspacePath(projectIdOrReference, workspaceId, ctx.companyId),
            payload,
          );
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    workspace
      .command("delete")
      .description("Delete a project workspace")
      .argument("<projectIdOrReference>", "Project ID or shortname/url-key")
      .argument("<workspaceId>", "Workspace ID")
      .option("--yes", "Required safety flag to confirm workspace deletion", false)
      .action(async (
        projectIdOrReference: string,
        workspaceId: string,
        opts: ProjectWorkspaceDeleteOptions,
      ) => {
        try {
          if (!opts.yes) {
            throw new Error("Workspace deletion requires --yes.");
          }
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<ProjectWorkspace>(
            buildProjectWorkspacePath(projectIdOrReference, workspaceId, ctx.companyId),
          );
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
