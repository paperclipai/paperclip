import { Command } from "commander";
import { testAdapterEnvironmentSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AdapterInstallOptions extends BaseClientOptions {
  package: string;
  localPath?: boolean;
  version?: string;
}

interface AdapterDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface AdapterModelsOptions extends BaseClientOptions {
  companyId?: string;
  refresh?: boolean;
}

interface AdapterTestEnvOptions extends BaseClientOptions {
  companyId?: string;
  adapterConfig?: string;
  environmentId?: string;
}

function parseJsonObject(
  raw: string | undefined,
  name: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--${name} must be valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function confirmAction(message: string): Promise<boolean> {
  const { confirm } = await import("@clack/prompts");
  const answer = await confirm({ message, initialValue: false });
  return answer === true;
}

export function registerAdapterCommands(program: Command): void {
  const adapter = program
    .command("adapter")
    .description("Adapter (instance) and per-company adapter introspection");

  addCommonClientOptions(
    adapter
      .command("list")
      .description("List installed adapters and their state")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>("/api/adapters")) ?? [];
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
                type: r.type as string | undefined,
                source: (r.source as string | undefined) ?? null,
                version: (r.version as string | undefined) ?? null,
                disabled: r.disabled as boolean | undefined,
                overridesBuiltin: r.overridesBuiltin as boolean | undefined,
                overridePaused: r.overridePaused as boolean | undefined,
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
    adapter
      .command("install")
      .description("Install an external adapter from npm or a local path (instance admin)")
      .requiredOption("--package <name>", "npm package name or local path")
      .option("--local-path", "Treat --package as a local filesystem path")
      .option("--version <version>", "npm version to install (npm packages only)")
      .action(async (opts: AdapterInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = { packageName: opts.package };
          if (opts.localPath) payload.isLocalPath = true;
          if (opts.version !== undefined) payload.version = opts.version;
          const row = await ctx.api.post<unknown>("/api/adapters/install", payload);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("enable")
      .description("Enable an adapter (instance admin)")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.patch<unknown>(
            `/api/adapters/${encodeURIComponent(type)}`,
            { disabled: false },
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("disable")
      .description("Disable an adapter (instance admin)")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.patch<unknown>(
            `/api/adapters/${encodeURIComponent(type)}`,
            { disabled: true },
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const override = adapter
    .command("override")
    .description("Pause/resume an external adapter's override of a builtin (instance admin)");

  for (const [verb, paused] of [["pause", true], ["resume", false]] as const) {
    addCommonClientOptions(
      override
        .command(verb)
        .description(`${verb[0].toUpperCase()}${verb.slice(1)} the override (paused=${paused})`)
        .argument("<type>", "Builtin adapter type")
        .action(async (type: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.patch<unknown>(
              `/api/adapters/${encodeURIComponent(type)}/override`,
              { paused },
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
    adapter
      .command("delete")
      .description("Unregister an external adapter (instance admin, builtins blocked)")
      .argument("<type>", "Adapter type")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (type: string, opts: AdapterDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(
              `Delete adapter ${type}? Existing agents using it will lose runtime support.`,
            );
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<unknown>(`/api/adapters/${encodeURIComponent(type)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("reload")
      .description("Reload an external adapter module without restarting the server")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/adapters/${encodeURIComponent(type)}/reload`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("reinstall")
      .description("Reinstall an npm-sourced adapter (pulls latest)")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/adapters/${encodeURIComponent(type)}/reinstall`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("config-schema")
      .description("Fetch an adapter's declarative config schema")
      .argument("<type>", "Adapter type")
      .action(async (type: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/adapters/${encodeURIComponent(type)}/config-schema`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("models")
      .description("List available models for an adapter in a company")
      .argument("<type>", "Adapter type")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--refresh", "Force refresh from upstream (slower)")
      .action(async (type: string, opts: AdapterModelsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.refresh) params.set("refresh", "1");
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/adapters/${encodeURIComponent(type)}/models${query}`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("model-profiles")
      .description("List adapter model profiles for a company")
      .argument("<type>", "Adapter type")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (type: string, opts: AdapterModelsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/adapters/${encodeURIComponent(type)}/model-profiles`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("detect-model")
      .description("Detect the most recently used model for an adapter")
      .argument("<type>", "Adapter type")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (type: string, opts: AdapterModelsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/adapters/${encodeURIComponent(type)}/detect-model`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adapter
      .command("test-environment")
      .description("Test an adapter config against a target environment")
      .argument("<type>", "Adapter type")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--adapter-config <json>", "Adapter config to test as JSON object")
      .option("--environment-id <id>", "Environment UUID (omit to test on local host)")
      .action(async (type: string, opts: AdapterTestEnvOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload: Record<string, unknown> = {};
          const adapterConfig = parseJsonObject(opts.adapterConfig, "adapter-config");
          if (adapterConfig !== undefined) payload.adapterConfig = adapterConfig;
          if (opts.environmentId !== undefined) payload.environmentId = opts.environmentId;

          const parsed = testAdapterEnvironmentSchema.parse(payload);
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/adapters/${encodeURIComponent(type)}/test-environment`,
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
