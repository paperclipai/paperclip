import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOptions extends BaseClientOptions {
  companyId?: string;
  projectId?: string;
}

interface JsonOptions extends CompanyOptions {
  payloadJson?: string;
  limit?: string;
}

export function registerRoutineApiCommands(program: Command): void {
  const routine = program.command("routine").description("Routine API operations");
  addCommonClientOptions(
    routine
      .command("list")
      .description("List routines")
      .option("-C, --company-id <id>", "Company ID")
      .option("--project-id <id>", "Filter by project ID")
      .action(async (opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = opts.projectId ? `?${new URLSearchParams({ projectId: opts.projectId }).toString()}` : "";
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/routines`}${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
  addCompanyPost(routine, "create", "Create a routine", "routines");
  addIdGet(routine, "get", "Get a routine", "routines");
  addIdPatch(routine, "update", "Update a routine", "routines");
  addIdGet(routine, "revisions", "List routine revisions", "routines", "revisions");
  addCommonClientOptions(
    routine
      .command("revision:restore")
      .description("Restore a routine revision")
      .argument("<routineId>", "Routine ID")
      .argument("<revisionId>", "Revision ID")
      .action(async (routineId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/routines/${routineId}/revisions/${revisionId}/restore`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addCommonClientOptions(
    routine
      .command("runs")
      .description("List routine runs")
      .argument("<routineId>", "Routine ID")
      .option("--limit <n>", "Maximum runs to return")
      .action(async (routineId: string, opts: JsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.limit ? `?${new URLSearchParams({ limit: opts.limit }).toString()}` : "";
          printOutput(await ctx.api.get(`${apiPath`/api/routines/${routineId}/runs`}${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addIdPost(routine, "run", "Run a routine", "routines", "run");
  addIdPost(routine, "trigger:create", "Create a routine trigger", "routines", "triggers");
  addIdPatch(routine, "trigger:update", "Update a routine trigger", "routine-triggers");
  addIdDelete(routine, "trigger:delete", "Delete a routine trigger", "routine-triggers");
  addIdPost(routine, "trigger:rotate-secret", "Rotate a routine trigger secret", "routine-triggers", "rotate-secret");
  addCommonClientOptions(
    routine
      .command("trigger:fire")
      .description("Fire a public routine trigger")
      .argument("<publicId>", "Public trigger ID")
      .option("--payload-json <json>", "Public trigger payload", "{}")
      .action(async (publicId: string, opts: JsonOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/routine-triggers/public/${publicId}/fire`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addCompanyPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).option("-C, --company-id <id>", "Company ID").requiredOption("--payload-json <json>", "JSON payload").action(async (opts: JsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts, { requireCompany: true });
      printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }), { includeCompany: false });
}

function addIdGet(parent: Command, name: string, description: string, resource: string, suffix?: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "ID").action(async (id: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/${resource}/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ""}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdPatch(parent: Command, name: string, description: string, resource: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "ID").requiredOption("--payload-json <json>", "JSON payload").action(async (id: string, opts: JsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.patch(`/api/${resource}/${encodeURIComponent(id)}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdPost(parent: Command, name: string, description: string, resource: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "ID").option("--payload-json <json>", "JSON payload", "{}").action(async (id: string, opts: JsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/${resource}/${encodeURIComponent(id)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addIdDelete(parent: Command, name: string, description: string, resource: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<id>", "ID").action(async (id: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.delete(`/api/${resource}/${encodeURIComponent(id)}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
