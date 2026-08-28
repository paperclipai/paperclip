import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AdapterOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson?: string;
  refresh?: boolean;
  environmentId?: string;
}

export function registerAdapterCommands(program: Command): void {
  const adapter = program.command("adapter").description("Adapter management operations");

  addCommonClientOptions(
    adapter
      .command("list")
      .description("List registered adapters")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/adapters"), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addJsonPost(adapter, "install", "Install an external adapter", "/api/adapters/install");

  addCommonClientOptions(
    adapter
      .command("get")
      .description("Get one adapter")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/adapters/${type}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addAdapterPatch(adapter, "update", "Update adapter settings", "");
  addAdapterPatch(adapter, "override", "Pause or resume a built-in adapter override", "/override");
  addAdapterPost(adapter, "reload", "Reload an adapter", "/reload");
  addAdapterPost(adapter, "reinstall", "Reinstall an adapter", "/reinstall");

  addCommonClientOptions(
    adapter
      .command("delete")
      .description("Delete an external adapter registration")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.delete(apiPath`/api/adapters/${type}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("config-schema")
      .description("Get adapter config schema")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/adapters/${type}/config-schema`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("ui-parser")
      .description("Get adapter UI parser JavaScript")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/adapters/${type}/ui-parser.js`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    adapter
      .command("models")
      .description("List adapter models for a company")
      .argument("<type>", "Adapter type")
      .option("-C, --company-id <id>", "Company ID")
      .option("--refresh", "Refresh provider model list", false)
      .option("--environment-id <id>", "Environment ID for environment-aware adapters")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams();
          if (opts.refresh) query.set("refresh", "true");
          if (opts.environmentId?.trim()) query.set("environmentId", opts.environmentId.trim());
          const suffix = query.size > 0 ? `?${query.toString()}` : "";
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/adapters/${type}/models`}${suffix}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCompanyAdapterGet(adapter, "model-profiles", "List adapter model profiles", "model-profiles");
  addCompanyAdapterGet(adapter, "detect-model", "Detect adapter model", "detect-model");
  addCompanyAdapterPost(adapter, "test-environment", "Test adapter environment configuration", "test-environment");
}

function addJsonPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent.command(name).description(description).requiredOption("--payload-json <json>", "JSON payload").action(async (opts: AdapterOptions) => {
      try {
        const ctx = resolveCommandContext(opts);
        printOutput(await ctx.api.post(path, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
  );
}

function addAdapterPatch(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "Adapter type")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.patch(`${apiPath`/api/adapters/${type}`}${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addAdapterPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "Adapter type")
      .option("--payload-json <json>", "JSON payload", "{}")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(`${apiPath`/api/adapters/${type}`}${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addCompanyAdapterGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "Adapter type")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/adapters/${type}`}/${suffix}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyAdapterPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<type>", "Adapter type")
      .option("-C, --company-id <id>", "Company ID")
      .option("--payload-json <json>", "JSON payload", "{}")
      .action(async (type: string, opts: AdapterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}/adapters/${type}`}/${suffix}`, parseJson(opts.payloadJson ?? "{}")),
            { json: ctx.json },
          );
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
