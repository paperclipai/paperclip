import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SkillOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson?: string;
  path?: string;
}

export function registerSkillCommands(program: Command): void {
  const skill = program.command("skill").description("Company skill operations");

  addCompanyGet(skill, "list", "List company skills", "skills");

  addCommonClientOptions(
    skill
      .command("get")
      .description("Get company skill details")
      .argument("<skillId>", "Skill ID")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (skillId: string, opts: SkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/skills/${skillId}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("file")
      .description("Read a company skill file")
      .argument("<skillId>", "Skill ID")
      .option("-C, --company-id <id>", "Company ID")
      .option("--path <path>", "Skill-relative file path", "SKILL.md")
      .action(async (skillId: string, opts: SkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ path: opts.path ?? "SKILL.md" });
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/skills/${skillId}/files`}?${query.toString()}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCompanyPost(skill, "create", "Create a local company skill", "skills", true);
  addCompanyPost(skill, "import", "Import company skills from a source", "skills/import", true);
  addCompanyPost(skill, "scan-projects", "Scan project workspaces for company skills", "skills/scan-projects", true);

  addCommonClientOptions(
    skill
      .command("file:update")
      .description("Update a company skill file")
      .argument("<skillId>", "Skill ID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "CompanySkillFileUpdate JSON payload")
      .action(async (skillId: string, opts: SkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.patch(apiPath`/api/companies/${ctx.companyId}/skills/${skillId}/files`, parseJson(opts.payloadJson ?? "{}")),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addSkillAction(skill, "update-status", "Get company skill update status", "update-status", "GET");
  addSkillAction(skill, "install-update", "Install available company skill update", "install-update", "POST");
  addSkillAction(skill, "delete", "Delete a company skill", "", "DELETE");
}

function addCompanyGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent.command(name).description(description).option("-C, --company-id <id>", "Company ID").action(async (opts: SkillOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addCompanyPost(parent: Command, name: string, description: string, path: string, requirePayload = false): void {
  const command = parent.command(name).description(description).option("-C, --company-id <id>", "Company ID");
  if (requirePayload) {
    command.requiredOption("--payload-json <json>", "JSON payload");
  } else {
    command.option("--payload-json <json>", "JSON payload", "{}");
  }
  addCommonClientOptions(
    command.action(async (opts: SkillOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addSkillAction(parent: Command, name: string, description: string, suffix: string, method: "GET" | "POST" | "DELETE"): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<skillId>", "Skill ID")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (skillId: string, opts: SkillOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const path = `${apiPath`/api/companies/${ctx.companyId}/skills/${skillId}`}${suffix ? `/${suffix}` : ""}`;
          const result =
            method === "GET"
              ? await ctx.api.get(path)
              : method === "POST"
                ? await ctx.api.post(path, {})
                : await ctx.api.delete(path);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
