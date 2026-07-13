import path from "node:path";
import { existsSync } from "node:fs";
import { Command, Option } from "commander";
import {
  scaffoldPluginProject,
  shellQuote,
  type ScaffoldPluginOptions,
} from "../../../../packages/plugins/create-paperclip-plugin/src/index.js";
import pc from "picocolors";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

// ---------------------------------------------------------------------------
// Types mirroring server-side shapes
// ---------------------------------------------------------------------------

interface PluginRecord {
  id: string;
  pluginKey: string;
  packageName: string;
  version: string;
  status: string;
  displayName?: string;
  lastError?: string | null;
  installedAt: string;
  updatedAt: string;
}

/** Subset of `GET /api/health` we surface as install/target diagnostics. */
interface TargetHealth {
  status?: string;
  version?: string;
  deploymentMode?: string;
  deploymentExposure?: string;
}

/** Result of probing the Paperclip instance the CLI is about to talk to. */
interface TargetDiagnostics {
  apiBase: string;
  reachable: boolean;
  health?: TargetHealth;
  error?: string;
}


// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

interface PluginListOptions extends BaseClientOptions {
  status?: string;
}

interface PluginInstallOptions extends BaseClientOptions {
  local?: boolean;
  version?: string;
  /** When false, skip the pre-install target-host health probe. Defaults true. */
  verifyTarget?: boolean;
}

interface PluginInstallRequest {
  packageName: string;
  version?: string;
  isLocalPath: boolean;
}

interface PluginUninstallOptions extends BaseClientOptions {
  force?: boolean;
}

interface PluginInitOptions extends BaseClientOptions {
  output?: string;
  template?: ScaffoldPluginOptions["template"];
  category?: ScaffoldPluginOptions["category"];
  displayName?: string;
  description?: string;
  author?: string;
  sdkPath?: string;
}

interface PluginJsonOptions extends BaseClientOptions {
  payloadJson?: string;
}

interface PluginStreamOptions extends BaseClientOptions {
  durationMs?: string;
}

interface PluginCompanyOptions extends PluginJsonOptions {
  companyId?: string;
}

interface PluginInitResult {
  outputDir: string;
  nextCommands: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHomePath(packageArg: string): string {
  if (!packageArg.startsWith("~")) return packageArg;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.resolve(home, packageArg.slice(1).replace(/^[\\/]/, ""));
}

function hasLocalPathSyntax(packageArg: string): boolean {
  return (
    path.isAbsolute(packageArg) ||
    packageArg.startsWith("./") ||
    packageArg.startsWith("../") ||
    packageArg.startsWith("~") ||
    packageArg.startsWith(".\\") ||
    packageArg.startsWith("..\\")
  );
}

function isExistingRelativePath(
  packageArg: string,
  cwd: string,
  pathExists: (targetPath: string) => boolean,
): boolean {
  if (packageArg.trim() === "") return false;
  if (hasLocalPathSyntax(packageArg)) return false;
  return pathExists(path.resolve(cwd, packageArg));
}

/**
 * Resolve a local path argument to an absolute path so the server can find the
 * plugin on disk regardless of where the user ran the CLI.
 */
function resolvePackageArg(packageArg: string, isLocal: boolean, cwd = process.cwd()): string {
  if (!isLocal) return packageArg;
  if (path.isAbsolute(packageArg)) return packageArg;
  if (packageArg.startsWith("~")) return expandHomePath(packageArg);
  return path.resolve(cwd, packageArg);
}

export function buildPluginInstallRequest(
  packageArg: string,
  opts: Pick<PluginInstallOptions, "local" | "version"> = {},
  deps: { cwd?: string; existsSync?: (targetPath: string) => boolean } = {},
): PluginInstallRequest {
  const cwd = deps.cwd ?? process.cwd();
  const pathExists = deps.existsSync ?? existsSync;
  const isLocal =
    opts.local ||
    hasLocalPathSyntax(packageArg) ||
    (opts.version ? false : isExistingRelativePath(packageArg, cwd, pathExists));

  if (isLocal && opts.version) {
    throw new Error("--version is only supported for npm package installs, not local plugin paths.");
  }

  return {
    packageName: resolvePackageArg(packageArg, Boolean(isLocal), cwd),
    version: opts.version,
    isLocalPath: Boolean(isLocal),
  };
}

export function renderLocalPluginInstallHint(packagePath: string): string {
  return [
    pc.dim("Local plugin installs run trusted local code from your machine."),
    pc.dim(`Keep ${pc.cyan("pnpm dev")} running in ${packagePath}; Paperclip watches rebuilt dist output and reloads the plugin worker.`),
  ].join("\n");
}

/**
 * Probe `GET /api/health` on the instance the CLI is configured to talk to so a
 * developer can confirm *which* Paperclip they are about to install into. This
 * exists because a local-path plugin can otherwise be silently installed into a
 * stale control-plane host that does not serve the branch's routes; surfacing
 * the API URL plus the server version/status catches that mismatch before the
 * plugin is exercised against the wrong runtime.
 */
export async function probeTargetDiagnostics(
  api: { apiBase: string; get(path: string): Promise<TargetHealth | null> },
): Promise<TargetDiagnostics> {
  try {
    const health = await api.get("/api/health");
    return {
      apiBase: api.apiBase,
      reachable: true,
      health: health ?? undefined,
    };
  } catch (err) {
    return {
      apiBase: api.apiBase,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Render the target-host diagnostics as human-readable lines. Pure so it can be
 * unit-tested without a live server.
 */
export function formatTargetDiagnostics(diag: TargetDiagnostics): string {
  const lines = [pc.dim(`Target Paperclip: ${pc.cyan(diag.apiBase)}`)];

  if (!diag.reachable) {
    lines.push(pc.yellow(`  health: unreachable${diag.error ? ` (${diag.error.split("\n")[0]})` : ""}`));
    lines.push(
      pc.dim(
        `  Verify the right instance is running, then pass ${pc.cyan("--api-base <url>")} or set ${pc.cyan("PAPERCLIP_API_URL")} if it lives elsewhere.`,
      ),
    );
    return lines.join("\n");
  }

  const health = diag.health ?? {};
  const detailParts: string[] = [];
  if (health.status) detailParts.push(`status=${health.status}`);
  if (health.version) detailParts.push(`version=${health.version}`);
  if (health.deploymentMode) detailParts.push(`mode=${health.deploymentMode}`);
  if (health.deploymentExposure) detailParts.push(`exposure=${health.deploymentExposure}`);

  lines.push(
    pc.dim(`  health: ${detailParts.length > 0 ? detailParts.join("  ") : "ok (no details exposed)"}`),
  );
  return lines.join("\n");
}

function formatPlugin(p: PluginRecord): string {
  const statusColor =
    p.status === "ready"
      ? pc.green(p.status)
      : p.status === "error"
        ? pc.red(p.status)
        : p.status === "disabled"
          ? pc.dim(p.status)
          : pc.yellow(p.status);

  const parts = [
    `key=${pc.bold(p.pluginKey)}`,
    `status=${statusColor}`,
    `version=${p.version}`,
    `id=${pc.dim(p.id)}`,
  ];

  if (p.lastError) {
    parts.push(`error=${pc.red(p.lastError.slice(0, 80))}`);
  }

  return parts.join("  ");
}

function packageToDirName(pluginName: string): string {
  return pluginName.replace(/^@[^/]+\//, "");
}

export function buildPluginInitScaffoldOptions(
  packageName: string,
  opts: PluginInitOptions,
  cwd = process.cwd(),
): ScaffoldPluginOptions {
  const outputRoot = path.resolve(cwd, opts.output ?? ".");
  const outputDir = path.resolve(outputRoot, packageToDirName(packageName));

  return {
    pluginName: packageName,
    outputDir,
    template: opts.template,
    category: opts.category,
    displayName: opts.displayName,
    description: opts.description,
    author: opts.author,
    sdkPath: opts.sdkPath,
  };
}

export function buildPluginInitNextCommands(outputDir: string): string[] {
  const quotedOutputDir = shellQuote(outputDir);
  return [
    `cd ${quotedOutputDir}`,
    "pnpm install",
    "pnpm dev",
    `paperclipai plugin install ${quotedOutputDir}`,
  ];
}

export function renderPluginInitSuccess(result: PluginInitResult): string {
  return [
    pc.green(`✓ Created plugin scaffold at ${result.outputDir}`),
    "",
    "Next commands:",
    ...result.nextCommands.map((command) => `  ${pc.cyan(command)}`),
  ].join("\n");
}

export function runPluginInitCommand(packageName: string, opts: PluginInitOptions): PluginInitResult {
  const scaffoldOptions = buildPluginInitScaffoldOptions(packageName, opts);
  const outputDir = scaffoldPluginProject(scaffoldOptions);
  return {
    outputDir,
    nextCommands: buildPluginInitNextCommands(outputDir),
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPluginCommands(program: Command): void {
  const plugin = program.command("plugin").description("Plugin lifecycle management");

  // -------------------------------------------------------------------------
  // plugin init <package-name>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("init <packageName>")
      .description("Scaffold a local Paperclip plugin project")
      .option("--output <dir>", "Directory to create the plugin folder in")
      .addOption(
        new Option("--template <template>", "Starter template")
          .choices(["default", "connector", "workspace", "environment"])
          .default("default"),
      )
      .addOption(
        new Option("--category <category>", "Manifest category")
          .choices(["connector", "workspace", "automation", "ui", "environment"]),
      )
      .option("--display-name <name>", "Manifest display name")
      .option("--description <description>", "Manifest description")
      .option("--author <author>", "Manifest author")
      .option("--sdk-path <path>", "Local @paperclipai/plugin-sdk package path")
      .action((packageName: string, opts: PluginInitOptions) => {
        try {
          const result = runPluginInitCommand(packageName, opts);

          if (opts.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(renderPluginInitSuccess(result));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin list
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("list")
      .description("List installed plugins")
      .option("--status <status>", "Filter by status (ready, error, disabled, installed, upgrade_pending)")
      .action(async (opts: PluginListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
          const plugins = await ctx.api.get<PluginRecord[]>(`/api/plugins${qs}`);

          if (ctx.json) {
            printOutput(plugins, { json: true });
            return;
          }

          const rows = plugins ?? [];
          if (rows.length === 0) {
            console.log(pc.dim("No plugins installed."));
            return;
          }

          for (const p of rows) {
            console.log(formatPlugin(p));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin install <package-or-path>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("install <package>")
      .description(
        "Install a plugin from a local path or npm package.\n" +
          "  Examples:\n" +
          "    paperclipai plugin install ./my-plugin              # local path\n" +
          "    paperclipai plugin install @acme/plugin-linear      # npm package\n" +
          "    paperclipai plugin install @acme/plugin-linear@1.2  # pinned version",
      )
      .option("-l, --local", "Treat <package> as a local filesystem path", false)
      .option("--version <version>", "Specific npm version to install (npm packages only)")
      .option(
        "--no-verify-target",
        "Skip the pre-install probe that reports which Paperclip instance the plugin installs into",
      )
      .action(async (packageArg: string, opts: PluginInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          const installRequest = buildPluginInstallRequest(packageArg, opts);

          // Make the install target explicit before sending the plugin to it. A
          // local-path plugin can otherwise be silently installed into a stale
          // control-plane host that lacks this branch's routes; printing the API
          // URL + server version/health lets the developer catch that mismatch.
          let target: TargetDiagnostics | undefined;
          if (opts.verifyTarget !== false) {
            target = await probeTargetDiagnostics(ctx.api);
            if (!ctx.json) {
              console.log(formatTargetDiagnostics(target));
            }
          }

          if (!ctx.json) {
            console.log(
              pc.dim(
                installRequest.isLocalPath
                  ? `Installing plugin from local path: ${installRequest.packageName}`
                  : `Installing plugin: ${installRequest.packageName}${opts.version ? `@${opts.version}` : ""}`,
              ),
            );
          }

          const installedPlugin = await ctx.api.post<PluginRecord>("/api/plugins/install", installRequest);

          if (ctx.json) {
            // Preserve the original flat PluginRecord shape so existing
            // automation reading top-level fields (id/pluginKey/version/status)
            // keeps working; attach target diagnostics as an additive field.
            printOutput({ ...installedPlugin, ...(target ? { target } : {}) }, { json: true });
            return;
          }

          if (!installedPlugin) {
            console.log(pc.dim("Install returned no plugin record."));
            return;
          }

          console.log(
            pc.green(
              `✓ Installed ${pc.bold(installedPlugin.pluginKey)} v${installedPlugin.version} (${installedPlugin.status})`,
            ),
          );

          if (installedPlugin.lastError) {
            console.log(pc.red(`  Warning: ${installedPlugin.lastError}`));
          }

          if (installRequest.isLocalPath) {
            console.log(renderLocalPluginInstallHint(installRequest.packageName));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin target
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("target")
      .description(
        "Show which Paperclip instance plugin commands will talk to.\n" +
          "  Reports the resolved API URL plus the server status/version/mode from\n" +
          "  GET /api/health so you can confirm you are installing into the branch\n" +
          "  runtime and not a stale control-plane host.",
      )
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const diag = await probeTargetDiagnostics(ctx.api);

          if (ctx.json) {
            printOutput(diag, { json: true });
            return;
          }

          console.log(formatTargetDiagnostics(diag));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin uninstall <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("uninstall <pluginKey>")
      .description(
        "Uninstall a plugin by its plugin key or database ID.\n" +
          "  Use --force to hard-purge all state and config.",
      )
      .option("--force", "Purge all plugin state and config (hard delete)", false)
      .action(async (pluginKey: string, opts: PluginUninstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const purge = opts.force === true;
          const qs = purge ? "?purge=true" : "";

          if (!ctx.json) {
            console.log(
              pc.dim(
                purge
                  ? `Uninstalling and purging plugin: ${pluginKey}`
                  : `Uninstalling plugin: ${pluginKey}`,
              ),
            );
          }

          const result = await ctx.api.delete<PluginRecord | null>(
            `/api/plugins/${encodeURIComponent(pluginKey)}${qs}`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`✓ Uninstalled ${pc.bold(pluginKey)}${purge ? " (purged)" : ""}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin enable <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("enable <pluginKey>")
      .description("Enable a disabled or errored plugin")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}/enable`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`✓ Enabled ${pc.bold(pluginKey)} — status: ${result?.status ?? "unknown"}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin disable <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("disable <pluginKey>")
      .description("Disable a running plugin without uninstalling it")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}/disable`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.dim(`Disabled ${pc.bold(pluginKey)} — status: ${result?.status ?? "unknown"}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin inspect <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("inspect <pluginKey>")
      .description("Show full details for an installed plugin")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          if (!result) {
            console.log(pc.red(`Plugin not found: ${pluginKey}`));
            process.exit(1);
          }

          console.log(formatPlugin(result));
          if (result.lastError) {
            console.log(`\n${pc.red("Last error:")}\n${result.lastError}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin examples
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("examples")
      .description("List bundled example plugins available for local install")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const examples = await ctx.api.get<
            Array<{
              packageName: string;
              pluginKey: string;
              displayName: string;
              description: string;
              localPath: string;
              tag: string;
            }>
          >("/api/plugins/examples");

          if (ctx.json) {
            printOutput(examples, { json: true });
            return;
          }

          const rows = examples ?? [];
          if (rows.length === 0) {
            console.log(pc.dim("No bundled examples available."));
            return;
          }

          for (const ex of rows) {
            console.log(
              `${pc.bold(ex.displayName)}  ${pc.dim(ex.pluginKey)}\n` +
                `  ${ex.description}\n` +
                `  ${pc.cyan(`paperclipai plugin install ${ex.localPath}`)}`,
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addPluginGet(plugin, "ui-contributions", "List plugin UI contributions", "/api/plugins/ui-contributions");
  addPluginGet(plugin, "tools", "List plugin tools", "/api/plugins/tools");
  addPluginPost(plugin, "tool:execute", "Execute a plugin tool", "/api/plugins/tools/execute");
  addPluginSubGet(plugin, "health", "Get plugin health", "health");
  addPluginSubGet(plugin, "logs", "Get plugin logs", "logs");
  addPluginSubPost(plugin, "upgrade", "Upgrade a plugin", "upgrade");
  addPluginSubGet(plugin, "config", "Get plugin config", "config");
  addPluginSubPost(plugin, "config:set", "Set plugin config", "config");
  addPluginSubPost(plugin, "config:test", "Test plugin config", "config/test");
  addPluginSubGet(plugin, "jobs", "List plugin jobs", "jobs");
  addPluginJobGet(plugin, "job:runs", "List plugin job runs", "runs");
  addPluginJobPost(plugin, "job:trigger", "Trigger a plugin job", "trigger");
  addPluginKeyPost(plugin, "webhook", "Deliver a plugin webhook", "webhooks");
  addPluginSubGet(plugin, "dashboard", "Get plugin dashboard data", "dashboard");
  addPluginSubPost(plugin, "bridge:data", "Send plugin bridge data", "bridge/data");
  addPluginSubPost(plugin, "bridge:action", "Send plugin bridge action", "bridge/action");
  addCommonClientOptions(
    plugin
      .command("bridge:stream")
      .description("Stream a plugin bridge channel")
      .argument("<pluginId>", "Plugin ID or key")
      .argument("<channel>", "Stream channel")
      .option("--duration-ms <ms>", "Stop streaming after this many milliseconds")
      .action(async (pluginId: string, channel: string, opts: PluginStreamOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          await streamPluginBridge(ctx.api.apiBase, ctx.api.apiKey, pluginId, channel, parseOptionalInt(opts.durationMs));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addPluginKeyPost(plugin, "data", "Get plugin URL-keyed data", "data");
  addPluginKeyPost(plugin, "action", "Invoke plugin URL-keyed action", "actions");
  addPluginLocalFolderGet(plugin, "local-folders", "List plugin local folder bindings");
  addPluginLocalFolderKeyGet(plugin, "local-folder:status", "Get plugin local folder status", "status");
  addPluginLocalFolderKeyPost(plugin, "local-folder:validate", "Validate plugin local folder binding", "validate");
  addPluginLocalFolderKeyPut(plugin, "local-folder:set", "Set plugin local folder binding");
}

function addPluginGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).action(async (opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(path), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).option("--payload-json <json>", "JSON payload", "{}").action(async (opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(path, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginSubGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "Plugin ID or key").action(async (pluginId: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginSubPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "Plugin ID or key").option("--payload-json <json>", "JSON payload", "{}").action(async (pluginId: string, opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginJobGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "Plugin ID or key").argument("<jobId>", "Job ID").action(async (pluginId: string, jobId: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/${suffix}`), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginJobPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "Plugin ID or key").argument("<jobId>", "Job ID").option("--payload-json <json>", "JSON payload", "{}").action(async (pluginId: string, jobId: string, opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/jobs/${encodeURIComponent(jobId)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginKeyPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(description).argument("<pluginId>", "Plugin ID or key").argument("<key>", "Endpoint or data/action key").option("--payload-json <json>", "JSON payload", "{}").action(async (pluginId: string, key: string, opts: PluginJsonOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`/api/plugins/${encodeURIComponent(pluginId)}/${suffix}/${encodeURIComponent(key)}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addPluginLocalFolderGet(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin ID or key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (pluginId: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyGet(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin ID or key")
      .argument("<folderKey>", "Local folder key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.get(`/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}/${suffix}`),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyPost(parent: Command, name: string, description: string, suffix: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin ID or key")
      .argument("<folderKey>", "Local folder key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--payload-json <json>", "JSON payload", "{}")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.post(
              `/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}/${suffix}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addPluginLocalFolderKeyPut(parent: Command, name: string, description: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .argument("<pluginId>", "Plugin ID or key")
      .argument("<folderKey>", "Local folder key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (pluginId: string, folderKey: string, opts: PluginCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(
            await ctx.api.put(
              `/api/plugins/${encodeURIComponent(pluginId)}/companies/${ctx.companyId}/local-folders/${encodeURIComponent(folderKey)}`,
              parseJson(opts.payloadJson ?? "{}"),
            ),
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

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

async function streamPluginBridge(
  apiBase: string,
  apiKey: string | undefined,
  pluginId: string,
  channel: string,
  durationMs: number | undefined,
): Promise<void> {
  const controller = new AbortController();
  const timer = durationMs === undefined ? null : setTimeout(() => controller.abort(), durationMs);
  try {
    const response = await fetch(buildApiUrl(
      apiBase,
      `/api/plugins/${encodeURIComponent(pluginId)}/bridge/stream/${encodeURIComponent(channel)}`,
    ), {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text.trim() || `Request failed with status ${response.status}`);
    }
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) process.stdout.write(decoder.decode(value, { stream: true }));
    }
    const trailing = decoder.decode();
    if (trailing) process.stdout.write(trailing);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}
