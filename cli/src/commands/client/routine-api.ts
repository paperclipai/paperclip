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

interface OnceTriggerOptions extends BaseClientOptions {
  at?: string;
  in?: string;
  label?: string;
}

const DURATION_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDurationMs(input: string): number {
  const match = /^(\d+)(s|m|h|d)?$/.exec(input.trim());
  if (!match) throw new Error(`Invalid duration "${input}" (use e.g. 90s, 15m, 2h, 1d)`);
  return Number(match[1]) * DURATION_UNIT_MS[match[2] ?? "s"];
}

function resolveOnceRunAt(opts: OnceTriggerOptions): string {
  if (opts.at && opts.in) throw new Error("Use only one of --at or --in");
  if (opts.at) {
    const at = new Date(opts.at);
    if (Number.isNaN(at.getTime())) throw new Error(`Invalid --at time "${opts.at}"`);
    return at.toISOString();
  }
  if (opts.in) return new Date(Date.now() + parseDurationMs(opts.in)).toISOString();
  throw new Error("Provide --at <iso> or --in <duration>");
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
  addCommonClientOptions(
    routine
      .command("trigger:once")
      .description("Create a one-shot trigger that fires the routine once at a given time")
      .argument("<routineId>", "Routine ID")
      .option("--at <iso>", "Absolute ISO-8601 time to fire (e.g. 2026-08-14T18:00:00Z)")
      .option("--in <duration>", "Relative delay from now (e.g. 90s, 15m, 2h, 1d)")
      .option("--label <label>", "Optional trigger label")
      .action(async (routineId: string, opts: OnceTriggerOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body: Record<string, unknown> = { kind: "once", runAt: resolveOnceRunAt(opts) };
          if (opts.label) body.label = opts.label;
          printOutput(await ctx.api.post(apiPath`/api/routines/${routineId}/triggers`, body), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
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
