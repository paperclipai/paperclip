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


// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

interface PluginListOptions extends BaseClientOptions {
  status?: string;
}

interface PluginInstallOptions extends BaseClientOptions {
  local?: boolean;
  version?: string;
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
      .action(async (packageArg: string, opts: PluginInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          const installRequest = buildPluginInstallRequest(packageArg, opts);

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
            printOutput(installedPlugin, { json: true });
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
}
