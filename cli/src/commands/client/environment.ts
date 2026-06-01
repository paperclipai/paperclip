import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  createEnvironmentSchema,
  probeEnvironmentConfigSchema,
  updateEnvironmentSchema,
  type Environment,
  type EnvironmentLease,
  type EnvironmentProbeResult,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface EnvironmentListOptions extends BaseClientOptions {
  companyId?: string;
  status?: string;
  driver?: string;
}

interface EnvironmentCapabilitiesOptions extends BaseClientOptions {
  companyId?: string;
}

interface EnvironmentCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  driver: string;
  description?: string;
  status?: string;
  driverConfig?: string;
  driverConfigFile?: string;
  metadata?: string;
  metadataFile?: string;
}

interface EnvironmentUpdateOptions extends BaseClientOptions {
  name?: string;
  description?: string;
  driver?: string;
  status?: string;
  driverConfig?: string;
  driverConfigFile?: string;
  metadata?: string;
  metadataFile?: string;
}

interface EnvironmentDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface EnvironmentProbeConfigOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  description?: string;
  driver: string;
  driverConfig?: string;
  driverConfigFile?: string;
  metadata?: string;
  metadataFile?: string;
}

interface EnvironmentLeaseListOptions extends BaseClientOptions {
  status?: string;
}

function readJsonOption(
  inline: string | undefined,
  filePath: string | undefined,
  flagName: string,
): Record<string, unknown> | undefined {
  if (inline !== undefined && filePath !== undefined) {
    throw new Error(`Pass either --${flagName} or --${flagName}-file, not both.`);
  }
  const raw =
    inline !== undefined
      ? inline
      : filePath !== undefined
        ? readFileSync(filePath, "utf8")
        : undefined;
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--${flagName} must be valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${flagName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function printEnvironmentRow(row: Environment): void {
  console.log(
    formatInlineRecord({
      id: row.id,
      name: row.name,
      driver: row.driver,
      status: row.status,
      configKeys: Object.keys(row.config ?? {}).length,
    }),
  );
}

function registerLeaseSubcommands(parent: Command): void {
  const lease = parent.command("lease").description("Environment lease operations");

  addCommonClientOptions(
    lease
      .command("list")
      .description("List leases for an environment")
      .argument("<environmentId>", "Environment ID")
      .option("--status <status>", "Filter by lease status")
      .action(async (environmentId: string, opts: EnvironmentLeaseListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.status
            ? `?status=${encodeURIComponent(opts.status)}`
            : "";
          const rows =
            (await ctx.api.get<EnvironmentLease[]>(
              `/api/environments/${encodeURIComponent(environmentId)}/leases${query}`,
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
                status: row.status,
                provider: row.provider ?? null,
                executionWorkspaceId: row.executionWorkspaceId ?? null,
                issueId: row.issueId ?? null,
                acquiredAt: row.acquiredAt instanceof Date
                  ? row.acquiredAt.toISOString()
                  : (row.acquiredAt as unknown as string),
                expiresAt: row.expiresAt instanceof Date
                  ? row.expiresAt.toISOString()
                  : (row.expiresAt as unknown as string | null),
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
    lease
      .command("get")
      .description("Get one environment lease")
      .argument("<leaseId>", "Lease ID")
      .action(async (leaseId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<EnvironmentLease>(
            `/api/environment-leases/${encodeURIComponent(leaseId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

export function registerEnvironmentCommands(program: Command): void {
  const env = program.command("environment").description("Execution environment operations");

  addCommonClientOptions(
    env
      .command("list")
      .description("List environments for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--status <status>", "Filter by environment status")
      .option("--driver <driver>", "Filter by environment driver")
      .action(async (opts: EnvironmentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.driver) params.set("driver", opts.driver);
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows =
            (await ctx.api.get<Environment[]>(
              `/api/companies/${ctx.companyId}/environments${query}`,
            )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) printEnvironmentRow(row);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    env
      .command("capabilities")
      .description("Show environment capabilities (drivers, sandbox providers) for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: EnvironmentCapabilitiesOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/environments/capabilities`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    env
      .command("get")
      .description("Get one environment")
      .argument("<environmentId>", "Environment ID")
      .action(async (environmentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Environment>(
            `/api/environments/${encodeURIComponent(environmentId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    env
      .command("create")
      .description("Create a new environment")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Environment name")
      .requiredOption("--driver <driver>", "Environment driver (e.g. local, ssh, sandbox)")
      .option("--description <text>", "Description")
      .option("--status <status>", "Environment status (e.g. active, disabled)")
      .option("--driver-config <json>", "Driver config as JSON object")
      .option("--driver-config-file <path>", "Path to JSON file with driver config")
      .option("--metadata <json>", "Metadata as JSON object")
      .option("--metadata-file <path>", "Path to JSON file with metadata")
      .action(async (opts: EnvironmentCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const config = readJsonOption(opts.driverConfig, opts.driverConfigFile, "driver-config");
          const metadata = readJsonOption(opts.metadata, opts.metadataFile, "metadata");

          const payload: Record<string, unknown> = {
            name: opts.name,
            driver: opts.driver,
          };
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.status !== undefined) payload.status = opts.status;
          if (config !== undefined) payload.config = config;
          if (metadata !== undefined) payload.metadata = metadata;

          const parsed = createEnvironmentSchema.parse(payload);
          const row = await ctx.api.post<Environment>(
            `/api/companies/${ctx.companyId}/environments`,
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
    env
      .command("update")
      .description("Update an environment")
      .argument("<environmentId>", "Environment ID")
      .option("--name <name>", "New name")
      .option("--description <text>", "New description")
      .option("--driver <driver>", "New driver (resets config unless --config provided)")
      .option("--status <status>", "New status")
      .option("--driver-config <json>", "Replacement/merge driver config as JSON object")
      .option("--driver-config-file <path>", "Path to JSON file with driver config")
      .option("--metadata <json>", "Metadata as JSON object")
      .option("--metadata-file <path>", "Path to JSON file with metadata")
      .action(async (environmentId: string, opts: EnvironmentUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const config = readJsonOption(opts.driverConfig, opts.driverConfigFile, "driver-config");
          const metadata = readJsonOption(opts.metadata, opts.metadataFile, "metadata");

          const payload: Record<string, unknown> = {};
          if (opts.name !== undefined) payload.name = opts.name;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.driver !== undefined) payload.driver = opts.driver;
          if (opts.status !== undefined) payload.status = opts.status;
          if (config !== undefined) payload.config = config;
          if (metadata !== undefined) payload.metadata = metadata;

          const parsed = updateEnvironmentSchema.parse(payload);
          const row = await ctx.api.patch<Environment>(
            `/api/environments/${encodeURIComponent(environmentId)}`,
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
    env
      .command("delete")
      .description("Delete an environment (releases SSH key secret if present)")
      .argument("<environmentId>", "Environment ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (environmentId: string, opts: EnvironmentDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const { confirm } = await import("@clack/prompts");
            const answer = await confirm({
              message: `Delete environment ${environmentId}? Active leases will be invalidated.`,
              initialValue: false,
            });
            if (answer !== true) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<Environment>(
            `/api/environments/${encodeURIComponent(environmentId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    env
      .command("probe")
      .description("Probe a saved environment to verify it is reachable")
      .argument("<environmentId>", "Environment ID")
      .action(async (environmentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<EnvironmentProbeResult>(
            `/api/environments/${encodeURIComponent(environmentId)}/probe`,
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
    env
      .command("probe-config")
      .description("Probe an unsaved environment config without persisting it")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--driver <driver>", "Environment driver")
      .option("--name <name>", "Display name (defaults to 'Unsaved environment')")
      .option("--description <text>", "Description")
      .option("--driver-config <json>", "Driver config as JSON object")
      .option("--driver-config-file <path>", "Path to JSON file with driver config")
      .option("--metadata <json>", "Metadata as JSON object")
      .option("--metadata-file <path>", "Path to JSON file with metadata")
      .action(async (opts: EnvironmentProbeConfigOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const config = readJsonOption(opts.driverConfig, opts.driverConfigFile, "driver-config");
          const metadata = readJsonOption(opts.metadata, opts.metadataFile, "metadata");

          const payload: Record<string, unknown> = { driver: opts.driver };
          if (opts.name !== undefined) payload.name = opts.name;
          if (opts.description !== undefined) payload.description = opts.description;
          if (config !== undefined) payload.config = config;
          if (metadata !== undefined) payload.metadata = metadata;

          const parsed = probeEnvironmentConfigSchema.parse(payload);
          const row = await ctx.api.post<EnvironmentProbeResult>(
            `/api/companies/${ctx.companyId}/environments/probe-config`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  registerLeaseSubcommands(env);
}
