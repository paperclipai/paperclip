import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  companyPortabilityExportSchema,
  companyPortabilityImportSchema,
  companyPortabilityPreviewSchema,
  createCompanySchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface PayloadOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface CompanyOnly extends BaseClientOptions {
  companyId?: string;
}

function readJson(opts: PayloadOptions, name: string): unknown {
  if (opts.payload !== undefined && opts.payloadFile !== undefined) {
    throw new Error(`Pass either --${name} or --${name}-file, not both.`);
  }
  if (opts.payload !== undefined) {
    try {
      return JSON.parse(opts.payload);
    } catch (err) {
      throw new Error(`--${name} must be valid JSON: ${(err as Error).message}`);
    }
  }
  if (opts.payloadFile !== undefined) {
    const raw = readFileSync(opts.payloadFile, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`--${name}-file must be valid JSON: ${(err as Error).message}`);
    }
  }
  return undefined;
}

function getCompanyCommand(program: Command): Command {
  const cmd = program.commands.find((c) => c.name() === "company");
  if (!cmd) throw new Error("company command not registered yet; load order error");
  return cmd;
}

export function registerCompanyExtensionCommands(program: Command): void {
  const company = getCompanyCommand(program);

  addCommonClientOptions(
    company
      .command("stats")
      .description("Get instance-wide company stats")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/companies/stats");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    company
      .command("create")
      .description("Create a new company")
      .option("--payload <json>", "Create payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = createCompanySchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>("/api/companies/", parsed);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    company
      .command("update")
      .description("Update a company (board: full schema; CEO agents: branding only)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--payload <json>", "Update payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          // Don't enforce updateCompanySchema vs updateCompanyBrandingSchema client-side
          // because the server picks based on actor type — let it validate.
          updateCompanySchema.parse(payload); // best-effort; will still pass branding-only via server
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.patch<unknown>(
            `/api/companies/${ctx.companyId}`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    company
      .command("branding-update")
      .description("Update only company branding (CEO agents allowed)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--payload <json>", "Branding payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = updateCompanyBrandingSchema.parse(payload);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.patch<unknown>(
            `/api/companies/${ctx.companyId}/branding`,
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
    company
      .command("archive")
      .description("Archive a company (board)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOnly) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/archive`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── server-side portability variants ────────────────────────────────────
  const portability = company.command("portability").description("Server-side portability flows");

  for (const [verb, path, schema] of [
    ["export-preview", "exports/preview", companyPortabilityExportSchema],
    ["export", "exports", companyPortabilityExportSchema],
    ["import-preview", "imports/preview", companyPortabilityPreviewSchema],
    ["import-apply", "imports/apply", companyPortabilityImportSchema],
  ] as const) {
    addCommonClientOptions(
      portability
        .command(verb)
        .description(`Per-company ${verb.replace("-", " ")}`)
        .requiredOption("-C, --company-id <id>", "Company ID")
        .option("--payload <json>", "Payload as JSON object")
        .option("--payload-file <path>", "Read payload from JSON file")
        .action(async (opts: PayloadOptions & CompanyOnly) => {
          try {
            const payload = readJson(opts, "payload");
            if (payload === undefined) throw new Error("--payload or --payload-file required");
            const parsed = schema.parse(payload);
            const ctx = resolveCommandContext(opts, { requireCompany: true });
            const row = await ctx.api.post<unknown>(
              `/api/companies/${ctx.companyId}/${path}`,
              parsed,
            );
            printOutput(row, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );
  }
}
