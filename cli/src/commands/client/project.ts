import { Command } from "commander";
import {
  createProjectSchema,
  updateProjectSchema,
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
}

interface ProjectCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  description?: string;
  status?: string;
  color?: string;
  targetDate?: string;
  leadAgentId?: string;
  goalId?: string;
  goalIds?: string;
}

interface ProjectUpdateOptions extends BaseClientOptions {
  name?: string;
  description?: string;
  status?: string;
  color?: string;
  targetDate?: string;
  leadAgentId?: string;
  goalIds?: string;
  archive?: boolean;
  unarchive?: boolean;
}

interface ProjectDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("Project operations");

  addCommonClientOptions(
    project
      .command("list")
      .description("List projects for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: ProjectListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<Project[]>(`/api/companies/${ctx.companyId}/projects`)) ?? [];

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
                status: row.status,
                urlKey: row.urlKey,
                leadAgentId: row.leadAgentId ?? null,
                archivedAt: row.archivedAt ?? null,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("get")
      .description("Get one project")
      .argument("<projectId>", "Project ID or shortname (with --company-id)")
      .action(async (projectId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = ctx.companyId ? `?companyId=${encodeURIComponent(ctx.companyId)}` : "";
          const row = await ctx.api.get<Project>(`/api/projects/${encodeURIComponent(projectId)}${query}`);
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
      .description("Create a new project in a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Project name")
      .option("--description <text>", "Project description")
      .option("--status <status>", "Project status (e.g. backlog, active, done)")
      .option("--color <color>", "Project color")
      .option("--target-date <date>", "Target completion date (ISO string)")
      .option("--lead-agent-id <id>", "Lead agent ID")
      .option("--goal-id <id>", "Linked goal ID (deprecated, prefer --goal-ids)")
      .option("--goal-ids <ids>", "Comma-separated goal IDs")
      .action(async (opts: ProjectCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload: Record<string, unknown> = { name: opts.name };
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.status !== undefined) payload.status = opts.status;
          if (opts.color !== undefined) payload.color = opts.color;
          if (opts.targetDate !== undefined) payload.targetDate = opts.targetDate;
          if (opts.leadAgentId !== undefined) payload.leadAgentId = opts.leadAgentId;
          if (opts.goalId !== undefined) payload.goalId = opts.goalId;
          if (opts.goalIds !== undefined) {
            payload.goalIds = opts.goalIds.split(",").map((id) => id.trim()).filter(Boolean);
          }

          const parsed = createProjectSchema.parse(payload);
          const row = await ctx.api.post<Project>(
            `/api/companies/${ctx.companyId}/projects`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("update")
      .description("Update a project")
      .argument("<projectId>", "Project ID")
      .option("--name <name>", "New name")
      .option("--description <text>", "New description")
      .option("--status <status>", "New status")
      .option("--color <color>", "New color")
      .option("--target-date <date>", "New target date (ISO string)")
      .option("--lead-agent-id <id>", "New lead agent ID")
      .option("--goal-ids <ids>", "Comma-separated goal IDs")
      .option("--archive", "Archive the project (sets archivedAt to now)")
      .option("--unarchive", "Unarchive the project (clears archivedAt)")
      .action(async (projectId: string, opts: ProjectUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.name !== undefined) payload.name = opts.name;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.status !== undefined) payload.status = opts.status;
          if (opts.color !== undefined) payload.color = opts.color;
          if (opts.targetDate !== undefined) payload.targetDate = opts.targetDate;
          if (opts.leadAgentId !== undefined) payload.leadAgentId = opts.leadAgentId;
          if (opts.goalIds !== undefined) {
            payload.goalIds = opts.goalIds.split(",").map((id) => id.trim()).filter(Boolean);
          }
          if (opts.archive && opts.unarchive) {
            throw new Error("Pass either --archive or --unarchive, not both.");
          }
          if (opts.archive) payload.archivedAt = new Date().toISOString();
          if (opts.unarchive) payload.archivedAt = null;

          const parsed = updateProjectSchema.parse(payload);
          const row = await ctx.api.patch<Project>(
            `/api/projects/${encodeURIComponent(projectId)}`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    project
      .command("delete")
      .description("Delete a project")
      .argument("<projectId>", "Project ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (projectId: string, opts: ProjectDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const confirmed = await confirmDelete(projectId);
            if (!confirmed) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<Project>(`/api/projects/${encodeURIComponent(projectId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const workspace = project.command("workspace").description("Project workspace operations");

  addCommonClientOptions(
    workspace
      .command("list")
      .description("List workspaces for a project")
      .argument("<projectId>", "Project ID")
      .action(async (projectId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows =
            (await ctx.api.get<ProjectWorkspace[]>(
              `/api/projects/${encodeURIComponent(projectId)}/workspaces`,
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
                sourceType: row.sourceType,
                cwd: row.cwd ?? null,
                repoUrl: row.repoUrl ?? null,
                isPrimary: row.isPrimary,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    workspace
      .command("delete")
      .description("Delete a project workspace")
      .argument("<projectId>", "Project ID")
      .argument("<workspaceId>", "Workspace ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (projectId: string, workspaceId: string, opts: ProjectDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const confirmed = await confirmDelete(`workspace ${workspaceId}`);
            if (!confirmed) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<ProjectWorkspace>(
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

async function confirmDelete(label: string): Promise<boolean> {
  const { confirm } = await import("@clack/prompts");
  const answer = await confirm({
    message: `Delete ${label}? This cannot be undone.`,
    initialValue: false,
  });
  return answer === true;
}
