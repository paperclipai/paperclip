import { readFileSync } from "node:fs";
import { Command } from "commander";
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

interface ParamsOptions extends BaseClientOptions {
  params?: string;
  paramsFile?: string;
  companyId?: string;
}

function readJson(opts: { payload?: string; payloadFile?: string }, name: string): unknown {
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

function readJsonParams(opts: ParamsOptions): Record<string, unknown> | undefined {
  const value = readJson(
    { payload: opts.params, payloadFile: opts.paramsFile },
    "params",
  );
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("--params must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function getPluginCommand(program: Command): Command {
  const cmd = program.commands.find((c) => c.name() === "plugin");
  if (!cmd) throw new Error("plugin command not registered yet; load order error");
  return cmd;
}

export function registerPluginExtensionCommands(program: Command): void {
  const plugin = getPluginCommand(program);

  // ── instance-level plugin info ──────────────────────────────────────────
  addCommonClientOptions(
    plugin
      .command("ui-contributions")
      .description("List UI contributions exposed by ready plugins")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/plugins/ui-contributions");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    plugin
      .command("tools")
      .description("List plugin-registered tools available to agents")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/plugins/tools");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    plugin
      .command("tools-execute")
      .description("Execute a plugin tool with a runContext")
      .option("--payload <json>", "Tool execute body { tool, parameters?, runContext } as JSON")
      .option("--payload-file <path>", "Read body from JSON file")
      .action(async (opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            "/api/plugins/tools/execute",
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── per-plugin runtime info ─────────────────────────────────────────────
  for (const [verb, path] of [
    ["health", "health"],
    ["logs", "logs"],
    ["dashboard", "dashboard"],
    ["jobs", "jobs"],
  ] as const) {
    addCommonClientOptions(
      plugin
        .command(verb)
        .description(`Get plugin ${verb}`)
        .argument("<pluginId>", "Plugin ID")
        .action(async (pluginId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.get<unknown>(
              `/api/plugins/${encodeURIComponent(pluginId)}/${path}`,
            );
            printOutput(row, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );
  }

  addCommonClientOptions(
    plugin
      .command("upgrade")
      .description("Upgrade a plugin to the latest registered version")
      .argument("<pluginId>", "Plugin ID")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/plugins/${encodeURIComponent(pluginId)}/upgrade`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── plugin config ───────────────────────────────────────────────────────
  const config = plugin.command("config").description("Plugin config get/set/test");

  addCommonClientOptions(
    config
      .command("get")
      .description("Get the saved plugin config")
      .argument("<pluginId>", "Plugin ID")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/plugins/${encodeURIComponent(pluginId)}/config`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    config
      .command("set")
      .description("Set the plugin config (replaces saved config)")
      .argument("<pluginId>", "Plugin ID")
      .option("--payload <json>", "Config object as JSON")
      .option("--payload-file <path>", "Read config from JSON file")
      .action(async (pluginId: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/plugins/${encodeURIComponent(pluginId)}/config`,
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
    config
      .command("test")
      .description("Test a plugin config without persisting it")
      .argument("<pluginId>", "Plugin ID")
      .option("--payload <json>", "Config object as JSON")
      .option("--payload-file <path>", "Read config from JSON file")
      .action(async (pluginId: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/plugins/${encodeURIComponent(pluginId)}/config/test`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── plugin jobs ─────────────────────────────────────────────────────────
  const job = plugin.command("job").description("Plugin job operations");

  addCommonClientOptions(
    job
      .command("runs")
      .description("List runs of a plugin job")
      .argument("<pluginId>", "Plugin ID")
      .argument("<jobId>", "Job ID")
      .action(async (pluginId: string, jobId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/runs`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    job
      .command("trigger")
      .description("Manually trigger a plugin job")
      .argument("<pluginId>", "Plugin ID")
      .argument("<jobId>", "Job ID")
      .option("--payload <json>", "Optional trigger body as JSON")
      .option("--payload-file <path>", "Read trigger body from JSON file")
      .action(async (pluginId: string, jobId: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload") ?? {};
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/trigger`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── webhook ─────────────────────────────────────────────────────────────
  addCommonClientOptions(
    plugin
      .command("webhook")
      .description("Trigger a plugin webhook endpoint")
      .argument("<pluginId>", "Plugin ID")
      .argument("<endpointKey>", "Webhook endpoint key")
      .option("--payload <json>", "Webhook body as JSON object")
      .option("--payload-file <path>", "Read webhook body from JSON file")
      .action(async (pluginId: string, endpointKey: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload") ?? {};
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/plugins/${encodeURIComponent(pluginId)}/webhooks/${encodeURIComponent(endpointKey)}`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── data / action bridge passthroughs ───────────────────────────────────
  addCommonClientOptions(
    plugin
      .command("data")
      .description("Call a plugin's getData(key) over the bridge")
      .argument("<pluginId>", "Plugin ID")
      .argument("<key>", "Data key")
      .option("-C, --company-id <id>", "Company ID for bridge scope (optional)")
      .option("--params <json>", "Params object as JSON")
      .option("--params-file <path>", "Read params from JSON file")
      .action(async (pluginId: string, key: string, opts: ParamsOptions) => {
        try {
          const params = readJsonParams(opts);
          const payload: Record<string, unknown> = {};
          if (opts.companyId !== undefined) payload.companyId = opts.companyId;
          if (params !== undefined) payload.params = params;
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/plugins/${encodeURIComponent(pluginId)}/data/${encodeURIComponent(key)}`,
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
    plugin
      .command("action")
      .description("Call a plugin's performAction(key) over the bridge")
      .argument("<pluginId>", "Plugin ID")
      .argument("<key>", "Action key")
      .option("-C, --company-id <id>", "Company ID for bridge scope (optional)")
      .option("--params <json>", "Params object as JSON")
      .option("--params-file <path>", "Read params from JSON file")
      .action(async (pluginId: string, key: string, opts: ParamsOptions) => {
        try {
          const params = readJsonParams(opts);
          const payload: Record<string, unknown> = {};
          if (opts.companyId !== undefined) payload.companyId = opts.companyId;
          if (params !== undefined) payload.params = params;
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(key)}`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
