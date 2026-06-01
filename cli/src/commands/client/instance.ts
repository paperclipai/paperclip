import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  issueGraphLivenessAutoRecoveryRequestSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SettingsPatchOptions extends BaseClientOptions {
  patch?: string;
  patchFile?: string;
}

interface AutoRecoveryOptions extends BaseClientOptions {
  lookbackHours?: string;
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

function parseIntOpt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`--${name} must be an integer`);
  }
  return n;
}

function readPatch(opts: SettingsPatchOptions): Record<string, unknown> {
  if (opts.patch !== undefined && opts.patchFile !== undefined) {
    throw new Error("Pass either --patch or --patch-file, not both.");
  }
  if (opts.patch !== undefined) {
    return parseJsonObject(opts.patch, "patch") ?? {};
  }
  if (opts.patchFile !== undefined) {
    const raw = readFileSync(opts.patchFile, "utf8");
    return parseJsonObject(raw, "patch-file") ?? {};
  }
  throw new Error("Pass --patch or --patch-file with the JSON patch object.");
}

export function registerInstanceCommands(program: Command): void {
  const instance = program
    .command("instance")
    .description("Instance-level settings and admin operations");

  const settings = instance.command("settings").description("Instance settings");

  for (const [verb, scope] of [
    ["general", "general"],
    ["experimental", "experimental"],
  ] as const) {
    addCommonClientOptions(
      settings
        .command(`${verb}-get`)
        .description(`Get ${scope} instance settings`)
        .action(async (opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.get<unknown>(
              `/api/instance/settings/${scope}`,
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
    settings
      .command("general-update")
      .description("Update general instance settings (instance admin)")
      .option("--patch <json>", "Patch object as JSON")
      .option("--patch-file <path>", "Read patch object from file")
      .action(async (opts: SettingsPatchOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const parsed = patchInstanceGeneralSettingsSchema.parse(readPatch(opts));
          const row = await ctx.api.patch<unknown>(
            "/api/instance/settings/general",
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
    settings
      .command("experimental-update")
      .description("Update experimental instance settings (instance admin)")
      .option("--patch <json>", "Patch object as JSON")
      .option("--patch-file <path>", "Read patch object from file")
      .action(async (opts: SettingsPatchOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const parsed = patchInstanceExperimentalSettingsSchema.parse(readPatch(opts));
          const row = await ctx.api.patch<unknown>(
            "/api/instance/settings/experimental",
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const autoRecovery = settings
    .command("auto-recovery")
    .description("Issue graph liveness auto-recovery (preview / run)");

  for (const verb of ["preview", "run"] as const) {
    addCommonClientOptions(
      autoRecovery
        .command(verb)
        .description(`${verb[0].toUpperCase()}${verb.slice(1)} the auto-recovery sweep`)
        .option("--lookback-hours <n>", "Override lookback window in hours")
        .action(async (opts: AutoRecoveryOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const payload: Record<string, unknown> = {};
            const lookback = parseIntOpt(opts.lookbackHours, "lookback-hours");
            if (lookback !== undefined) payload.lookbackHours = lookback;
            const parsed = issueGraphLivenessAutoRecoveryRequestSchema.parse(payload);
            const row = await ctx.api.post<unknown>(
              `/api/instance/settings/experimental/issue-graph-liveness-auto-recovery/${verb}`,
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

  addCommonClientOptions(
    instance
      .command("backup-now")
      .description("Trigger a manual database backup (instance admin)")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            "/api/instance/database-backups",
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
    instance
      .command("health")
      .description("Server health check (db reachability, dev server, bootstrap)")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/health/");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
