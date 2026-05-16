import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  companySkillCreateSchema,
  companySkillFileUpdateSchema,
  companySkillImportSchema,
  companySkillProjectScanRequestSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SkillListOptions extends BaseClientOptions {
  companyId?: string;
}

interface SkillCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  slug?: string;
  description?: string;
  markdown?: string;
  markdownFile?: string;
}

interface SkillImportOptions extends BaseClientOptions {
  companyId?: string;
  source: string;
}

interface SkillScanOptions extends BaseClientOptions {
  companyId?: string;
  projectIds?: string;
  workspaceIds?: string;
}

interface SkillFileGetOptions extends BaseClientOptions {
  companyId?: string;
  path?: string;
}

interface SkillFileUpdateOptions extends BaseClientOptions {
  companyId?: string;
  path: string;
  content?: string;
  contentFile?: string;
}

interface SkillDeleteOptions extends BaseClientOptions {
  companyId?: string;
  yes?: boolean;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

async function confirmAction(message: string): Promise<boolean> {
  const { confirm } = await import("@clack/prompts");
  const answer = await confirm({ message, initialValue: false });
  return answer === true;
}

export function registerCompanySkillCommands(program: Command): void {
  const skill = program
    .command("company-skill")
    .description("Company skill (markdown + scripts) library");

  addCommonClientOptions(
    skill
      .command("list")
      .description("List company skills")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SkillListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/skills`,
          )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const r of rows as Array<Record<string, unknown>>) {
            console.log(
              formatInlineRecord({
                id: r.id as string,
                slug: r.slug as string,
                name: r.name as string,
                sourceType: r.sourceType as string | null,
                trustLevel: r.trustLevel as string | null,
                attachedAgentCount: (r.attachedAgentCount as number | null) ?? null,
                editable: r.editable as boolean | null,
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
    skill
      .command("get")
      .description("Get one company skill with usage details")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<skillId>", "Skill ID")
      .action(async (skillId: string, opts: SkillListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("update-status")
      .description("Check whether an upstream update is available for a tracked skill")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<skillId>", "Skill ID")
      .action(async (skillId: string, opts: SkillListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}/update-status`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("file-get")
      .description("Read one file inside a skill (defaults to SKILL.md)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<skillId>", "Skill ID")
      .option("--path <relative>", "File path within the skill", "SKILL.md")
      .action(async (skillId: string, opts: SkillFileGetOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.path) params.set("path", opts.path);
          const query = params.toString() ? `?${params.toString()}` : "";
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}/files${query}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("create")
      .description("Create a new local skill in the company library")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Skill display name")
      .option("--slug <slug>", "URL slug (auto-derived if omitted)")
      .option("--description <text>", "Description")
      .option("--markdown <text>", "Initial SKILL.md content")
      .option("--markdown-file <path>", "Read SKILL.md content from file")
      .action(async (opts: SkillCreateOptions) => {
        try {
          if (opts.markdown !== undefined && opts.markdownFile !== undefined) {
            throw new Error("Pass either --markdown or --markdown-file, not both.");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });

          const payload: Record<string, unknown> = { name: opts.name };
          if (opts.slug !== undefined) payload.slug = opts.slug;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.markdown !== undefined) payload.markdown = opts.markdown;
          if (opts.markdownFile !== undefined) {
            payload.markdown = readFileSync(opts.markdownFile, "utf8");
          }

          const parsed = companySkillCreateSchema.parse(payload);
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/skills`,
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
    skill
      .command("import")
      .description("Import skills from a source (github URL, skills.sh, local path, catalog ref)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--source <source>", "Source string")
      .action(async (opts: SkillImportOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const parsed = companySkillImportSchema.parse({ source: opts.source });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/skills/import`,
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
    skill
      .command("scan-projects")
      .description("Scan project workspaces for skills directories and import them")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--project-ids <list>", "Comma-separated project UUIDs")
      .option("--workspace-ids <list>", "Comma-separated workspace UUIDs")
      .action(async (opts: SkillScanOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload: Record<string, unknown> = {};
          const projectIds = splitCsv(opts.projectIds);
          if (projectIds !== undefined) payload.projectIds = projectIds;
          const workspaceIds = splitCsv(opts.workspaceIds);
          if (workspaceIds !== undefined) payload.workspaceIds = workspaceIds;

          const parsed = companySkillProjectScanRequestSchema.parse(payload);
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/skills/scan-projects`,
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
    skill
      .command("file-update")
      .description("Replace a file's content inside a skill")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<skillId>", "Skill ID")
      .requiredOption("--path <relative>", "File path within the skill")
      .option("--content <text>", "New content")
      .option("--content-file <path>", "Read new content from a file")
      .action(async (skillId: string, opts: SkillFileUpdateOptions) => {
        try {
          if (opts.content !== undefined && opts.contentFile !== undefined) {
            throw new Error("Pass either --content or --content-file, not both.");
          }
          let content: string;
          if (opts.contentFile !== undefined) {
            content = readFileSync(opts.contentFile, "utf8");
          } else if (opts.content !== undefined) {
            content = opts.content;
          } else {
            throw new Error("Pass --content or --content-file.");
          }

          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const parsed = companySkillFileUpdateSchema.parse({ path: opts.path, content });
          const row = await ctx.api.patch<unknown>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}/files`,
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
    skill
      .command("delete")
      .description("Delete a company skill")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<skillId>", "Skill ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (skillId: string, opts: SkillDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(
              `Delete skill ${skillId}? Agents that reference it will lose the skill.`,
            );
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.delete<unknown>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("install-update")
      .description("Pull the latest version for a tracked skill")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<skillId>", "Skill ID")
      .action(async (skillId: string, opts: SkillListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/skills/${encodeURIComponent(skillId)}/install-update`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
