/**
 * @fileoverview Plugin CLI commands for Paperclip
 *
 * This module provides command-line interface commands for managing Paperclip plugins.
 * It supports the full plugin lifecycle: listing, installing, uninstalling, enabling,
 * disabling, upgrading, and creating new plugin projects.
 *
 * @example
 * ```bash
 * # List all plugins
 * paperclipai plugin list
 *
 * # Install from npm
 * paperclipai plugin install @paperclip/plugin-linear
 *
 * # Install from local path
 * paperclipai plugin install ./my-plugin
 *
 * # Create a new plugin
 * paperclipai plugin create my-plugin --template connector
 * ```
 *
 * @module cli/commands/client/plugin
 */

import { Command } from "commander";
import pc from "picocolors";
import path from "node:path";
import {
  PLUGIN_CATEGORIES,
  type PluginCategory,
  type PluginRecord,
} from "@paperclipai/shared";
import { scaffoldPluginProject, isValidPluginName } from "@paperclipai/create-paperclip-plugin";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

/** Options for the plugin list command */
interface PluginListOptions extends BaseClientOptions {
  /** Filter plugins by status (installed, ready, error, upgrade_pending, uninstalled) */
  status?: string;
}

/**
 * Valid plugin lifecycle statuses as defined in PLUGIN_SPEC.md
 * @see doc/plugins/PLUGIN_SPEC.md
 */
const VALID_PLUGIN_STATUSES = ["installed", "ready", "error", "upgrade_pending", "uninstalled"] as const;
type PluginStatusFilter = typeof VALID_PLUGIN_STATUSES[number];

/**
 * Valid plugin templates for scaffolding new plugin projects
 * - default: Basic plugin with worker entrypoint
 * - connector: Plugin for connecting to external services
 * - workspace: Plugin for workspace/file system operations
 */
const VALID_PLUGIN_TEMPLATES = ["default", "connector", "workspace"] as const;
type PluginTemplate = typeof VALID_PLUGIN_TEMPLATES[number];
const VALID_PLUGIN_CATEGORIES = new Set<PluginCategory>(PLUGIN_CATEGORIES);

/** Options for the plugin install command */
interface PluginInstallOptions extends BaseClientOptions {
  /** Target version for npm packages (ignored for local paths) */
  version?: string;
}

/** Options for the plugin uninstall command */
interface PluginUninstallOptions extends BaseClientOptions {
  /** Skip confirmation prompt (required for non-interactive mode) */
  force?: boolean;
  /** Permanently delete plugin data instead of soft-delete with 30-day retention */
  purge?: boolean;
}

/** Options for the plugin enable command */
interface PluginEnableOptions extends BaseClientOptions {}

/** Options for the plugin disable command */
interface PluginDisableOptions extends BaseClientOptions {
  /** Optional reason for disabling the plugin */
  reason?: string;
}

/** Options for the plugin create (scaffold) command */
interface PluginCreateOptions extends BaseClientOptions {
  /** Template to use: default, connector, or workspace */
  template?: PluginTemplate;
  /** Human-readable display name for the plugin */
  displayName?: string;
  /** Plugin description */
  description?: string;
  /** Plugin author name */
  author?: string;
  /** Plugin category: connector, workspace, automation, or ui */
  category?: PluginCategory;
  /** Output directory for the new plugin project */
  outputDir?: string;
}

/**
 * Register all plugin management commands with the CLI program.
 *
 * Commands registered:
 * - `plugin list` - List installed plugins with optional status filter
 * - `plugin install <package>` - Install from npm or local path
 * - `plugin uninstall <pluginId>` - Uninstall with optional purge
 * - `plugin enable <pluginId>` - Enable a disabled plugin
 * - `plugin disable <pluginId>` - Disable a running plugin
 * - `plugin get <pluginId>` - Get detailed plugin information
 * - `plugin doctor <pluginId>` - Run health diagnostics
 * - `plugin create <name>` - Scaffold a new plugin project
 * - `plugin upgrade <pluginId>` - Upgrade to a newer version
 *
 * All commands support:
 * - `--json` for raw JSON output (useful for scripting)
 * - Common client options (API URL, auth, etc.)
 *
 * @param program - The Commander program instance to register commands with
 * @example
 * ```typescript
 * import { Command } from "commander";
 * import { registerPluginCommands } from "./commands/client/plugin.js";
 *
 * const program = new Command();
 * registerPluginCommands(program);
 * program.parse();
 * ```
 */
export function registerPluginCommands(program: Command): void {
  const plugin = program.command("plugin").description("Plugin management");

  // plugin list
  addCommonClientOptions(
    plugin
      .command("list")
      .description("List installed plugins")
      .option("--status <status>", "Filter by status (installed, ready, error, upgrade_pending, uninstalled)")
      .action(async (opts: PluginListOptions) => {
        try {
          // Validate status if provided
          if (opts.status && !VALID_PLUGIN_STATUSES.includes(opts.status as PluginStatusFilter)) {
            console.error(pc.red(`Invalid status: ${opts.status}`));
            console.error(pc.dim(`Valid statuses: ${VALID_PLUGIN_STATUSES.join(", ")}`));
            process.exit(1);
          }

          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          const query = params.toString();
          const path = `/api/plugins${query ? `?${query}` : ""}`;
          const rows = (await ctx.api.get<PluginRecord[]>(path)) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            console.log(pc.dim("No plugins installed."));
            return;
          }

          for (const item of rows) {
            const status = formatStatus(item.status);
            console.log(
              formatInlineRecord({
                id: item.pluginKey,
                version: item.version,
                status,
                displayName: item.manifestJson?.displayName ?? item.pluginKey,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // plugin install
  addCommonClientOptions(
    plugin
      .command("install")
      .description("Install a plugin from an npm package or local path")
      .argument("<package>", "npm package name (e.g. @paperclip/plugin-linear) or local path (e.g. ./my-plugin)")
      .option("--version <version>", "Package version (for npm packages)")
      .action(async (packageName: string, opts: PluginInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          // Determine if this is a local path or npm package
          const isLocalPath = packageName.startsWith("./") ||
            packageName.startsWith("../") ||
            packageName.startsWith("/") ||
            /^[A-Za-z]:/.test(packageName); // Windows absolute path

          const resolvedPackageName = isLocalPath ? path.resolve(packageName) : packageName;

          console.log(pc.dim(`Installing plugin from ${isLocalPath ? "local path" : "npm"}: ${packageName}`));

          const payload: Record<string, unknown> = {
            packageName: resolvedPackageName,
            isLocalPath,
          };

          if (opts.version && !isLocalPath) {
            payload.version = opts.version;
          }

          const result = await ctx.api.post<PluginRecord>("/api/plugins/install", payload);

          if (!result) {
            console.error(pc.red("Plugin installation failed: no response from server"));
            process.exit(1);
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`Plugin installed: ${result.pluginKey}@${result.version}`));
          console.log(pc.dim(`Status: ${result.status}`));

          if (result.status === "error" && result.lastError) {
            console.log(pc.red(`Last error: ${result.lastError}`));
            if (isLocalPath) {
              console.log(pc.dim("For local path installs, ensure the plugin is built (e.g. pnpm build in the plugin directory)."));
            }
          }

          if (result.manifestJson?.capabilities?.length) {
            console.log(pc.dim(`Capabilities: ${result.manifestJson.capabilities.join(", ")}`));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // plugin uninstall
  addCommonClientOptions(
    plugin
      .command("uninstall")
      .description("Uninstall a plugin")
      .argument("<pluginId>", "Plugin ID (plugin key)")
      .option("--force", "Skip confirmation prompt (required for non-interactive mode)")
      .option("--purge", "Permanently delete plugin data (hard delete)")
      .action(async (pluginId: string, opts: PluginUninstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const encodedPluginId = encodeURIComponent(pluginId);

          if (!opts.force) {
            const message = opts.purge
              ? `Permanently delete plugin "${pluginId}" and all its data?`
              : `Uninstall plugin "${pluginId}"? (data will be retained for 30 days)`;
            console.error(pc.yellow(`Confirmation required: ${message}`));
            console.error(pc.dim("Use --force to skip this confirmation."));
            process.exit(1);
          }

          const params = new URLSearchParams();
          if (opts.purge) params.set("purge", "true");

          const query = params.toString();
          const path = `/api/plugins/${encodedPluginId}${query ?`?${query}` : ""}`;

          const result = await ctx.api.delete<PluginRecord>(path);

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`Plugin uninstalled: ${pluginId}`));
          if (!opts.purge) {
            console.log(pc.dim("Plugin data retained for 30 days. Use --purge to delete immediately."));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // plugin enable
  addCommonClientOptions(
    plugin
      .command("enable")
      .description("Enable a disabled or error-state plugin")
      .argument("<pluginId>", "Plugin ID (plugin key)")
      .action(async (pluginId: string, opts: PluginEnableOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const encodedPluginId = encodeURIComponent(pluginId);

          const result = await ctx.api.post<PluginRecord>(`/api/plugins/${encodedPluginId}/enable`, {});

          if (!result) {
            console.error(pc.red("Enable operation failed: no response from server"));
            process.exit(1);
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`Plugin enabled: ${pluginId}`));
          console.log(pc.dim(`Status: ${formatStatus(result.status)}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // plugin disable
  addCommonClientOptions(
    plugin
      .command("disable")
      .description("Disable a running plugin")
      .argument("<pluginId>", "Plugin ID (plugin key)")
      .option("--reason <reason>", "Reason for disabling")
      .action(async (pluginId: string, opts: PluginDisableOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const encodedPluginId = encodeURIComponent(pluginId);

          const payload = opts.reason ? { reason: opts.reason } : {};
          const result = await ctx.api.post<PluginRecord>(`/api/plugins/${encodedPluginId}/disable`, payload);

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.yellow(`Plugin disabled: ${pluginId}`));
          if (opts.reason) {
            console.log(pc.dim(`Reason: ${opts.reason}`));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // plugin get
  addCommonClientOptions(
    plugin
      .command("get")
      .description("Get details for a specific plugin")
      .argument("<pluginId>", "Plugin ID (plugin key)")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const encodedPluginId = encodeURIComponent(pluginId);

          const result = await ctx.api.get<PluginRecord>(`/api/plugins/${encodedPluginId}`);

          if (!result) {
            console.error(pc.red(`Plugin not found: ${pluginId}`));
            process.exit(1);
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          printPluginDetails(result);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // plugin doctor
  addCommonClientOptions(
    plugin
      .command("doctor")
      .description("Run diagnostics on a plugin")
      .argument("<pluginId>", "Plugin ID (plugin key)")
      .action(async (pluginId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const encodedPluginId = encodeURIComponent(pluginId);

          const result = await ctx.api.get<{
            pluginId: string;
            status: string;
            healthy: boolean;
            checks: Array<{
              name: string;
              passed: boolean;
              message?: string;
            }>;
            lastError?: string;
          }>(`/api/plugins/${encodedPluginId}/health`);

          if (!result) {
            console.error(pc.red(`Health check failed for plugin: ${pluginId}`));
            process.exit(1);
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.bold(`Plugin health: ${pluginId}`));
          console.log(pc.dim(`Status: ${result.status}`));
          console.log(pc.dim(`Healthy: ${result.healthy ? pc.green("yes") : pc.red("no")}`));

          if (result.lastError) {
            console.log(pc.red(`Last error: ${result.lastError}`));
          }

          console.log();
          console.log(pc.bold("Checks:"));
          for (const check of result.checks) {
            const icon = check.passed ? pc.green("✓") : pc.red("✗");
            console.log(`  ${icon} ${check.name}${check.message ? `: ${check.message}` : ""}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // plugin create (scaffolding)
  addCommonClientOptions(
    plugin
      .command("create")
      .description("Create a new plugin project from a template")
      .argument("<name>", "Plugin name (e.g. my-plugin or @scope/my-plugin)")
      .option("--template <template>", "Template to use (default, connector, workspace)", "default")
      .option("--display-name <name>", "Human-readable display name")
      .option("--description <desc>", "Plugin description")
      .option("--author <author>", "Author name")
      .option("--category <category>", "Plugin category (connector, workspace, automation, ui)")
      .option("-o, --output-dir <dir>", "Output directory", ".")
      .action(async (pluginName: string, opts: PluginCreateOptions) => {
        try {
          const outputDir = path.resolve(opts.outputDir || ".", pluginName.replace(/^@[^/]+\//, ""));

          // Validate template
          const template: PluginTemplate = opts.template || "default";
          if (!VALID_PLUGIN_TEMPLATES.includes(template as PluginTemplate)) {
            console.error(pc.red(`Invalid template: ${template}`));
            console.error(pc.dim(`Valid templates: ${VALID_PLUGIN_TEMPLATES.join(", ")}`));
            process.exit(1);
          }

          if (opts.category && !VALID_PLUGIN_CATEGORIES.has(opts.category)) {
            console.error(pc.red(`Invalid category: ${opts.category}`));
            console.error(pc.dim(`Valid categories: ${PLUGIN_CATEGORIES.join(", ")}`));
            process.exit(1);
          }

          console.log(pc.dim(`Creating plugin: ${pluginName}`));
          console.log(pc.dim(`Output directory: ${outputDir}`));

          // Validate plugin name
          if (!isValidPluginName(pluginName)) {
            console.error(pc.red("Invalid plugin name. Must be lowercase alphanumeric with dots, hyphens, or underscores."));
            process.exit(1);
          }

          // Generate the plugin scaffold
          scaffoldPluginProject({
            pluginName,
            outputDir,
            template,
            displayName: opts.displayName,
            description: opts.description,
            author: opts.author,
            category: opts.category,
          });

          console.log();
          console.log(pc.green("Plugin created successfully!"));
          console.log();
          console.log(pc.bold("Next steps:"));
          console.log(pc.dim(`  cd ${path.relative(".", outputDir) || "."}`));
          console.log(pc.dim("  pnpm install"));
          console.log(pc.dim("  pnpm build"));
          console.log(pc.dim(`  paperclipai plugin install ./${path.relative(".", outputDir) || "."}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // plugin upgrade
  addCommonClientOptions(
    plugin
      .command("upgrade")
      .description("Upgrade a plugin to a newer version")
      .argument("<pluginId>", "Plugin ID (plugin key)")
      .option("--version <version>", "Target version (latest if not specified)")
      .action(async (pluginId: string, opts: BaseClientOptions & { version?: string }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const encodedPluginId = encodeURIComponent(pluginId);

          const payload: Record<string, unknown> = {};
          if (opts.version) {
            payload.version = opts.version;
          }

          console.log(pc.dim(`Upgrading plugin: ${pluginId}`));

          const result = await ctx.api.post<PluginRecord>(`/api/plugins/${encodedPluginId}/upgrade`, payload);

          if (!result) {
            console.error(pc.red("Upgrade failed: no response from server"));
            process.exit(1);
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`Plugin upgraded: ${pluginId}@${result.version}`));
          console.log(pc.dim(`Status: ${formatStatus(result.status)}`));

          if (result.status === "upgrade_pending") {
            console.log(pc.yellow("Upgrade requires capability approval. Visit the plugin settings page to approve."));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a plugin status string with appropriate color coding.
 *
 * Color mapping:
 * - ready → green
 * - installed → blue
 * - error → red
 * - upgrade_pending → yellow
 * - uninstalled (and others) → dim
 *
 * @param status - The plugin status to format
 * @returns Colorized status string
 */
function formatStatus(status: string): string {
  const statusColors: Record<string, (str: string) => string> = {
    ready: pc.green,
    installed: pc.blue,
    error: pc.red,
    upgrade_pending: pc.yellow,
    uninstalled: pc.dim,
  };
  const color = statusColors[status] || pc.dim;
  return color(status);
}

/**
 * Print detailed information about a plugin to the console.
 *
 * Displays:
 * - Basic info: ID, version, status, package name, timestamps
 * - Error information if present
 * - Manifest details: API version, categories, author, description
 * - Capabilities list
 * - Agent tools (if any)
 * - UI slots (if any)
 *
 * Output is formatted with colors and visual separators for readability.
 *
 * @param plugin - The plugin record to display
 */
function printPluginDetails(plugin: PluginRecord): void {
  console.log(pc.bold(plugin.manifestJson?.displayName ?? plugin.pluginKey));
  console.log(pc.dim("─".repeat(40)));
  console.log(`ID:          ${plugin.pluginKey}`);
  console.log(`Version:     ${plugin.version}`);
  console.log(`Status:      ${formatStatus(plugin.status)}`);
  console.log(`Package:     ${plugin.packageName}`);
  console.log(`Installed:   ${plugin.installedAt}`);
  console.log(`Updated:     ${plugin.updatedAt}`);

  if (plugin.lastError) {
    console.log(pc.red(`Error:       ${plugin.lastError}`));
  }

  const manifest = plugin.manifestJson;
  if (manifest) {
    console.log();
    console.log(pc.bold("Manifest"));
    console.log(pc.dim("─".repeat(40)));
    console.log(`API Version: ${manifest.apiVersion}`);
    console.log(`Categories:  ${manifest.categories?.join(", ") ?? "-"}`);
    console.log(`Author:      ${manifest.author ?? "-"}`);
    console.log(`Description: ${manifest.description ?? "-"}`);

    if (manifest.capabilities?.length) {
      console.log();
      console.log(pc.bold("Capabilities"));
      console.log(pc.dim("─".repeat(40)));
      for (const cap of manifest.capabilities) {
        console.log(`  • ${cap}`);
      }
    }

    if (manifest.tools?.length) {
      console.log();
      console.log(pc.bold("Agent Tools"));
      console.log(pc.dim("─".repeat(40)));
      for (const tool of manifest.tools) {
        console.log(`  • ${tool.name}: ${tool.displayName}`);
      }
    }

    if (manifest.ui?.slots?.length) {
      console.log();
      console.log(pc.bold("UI Slots"));
      console.log(pc.dim("─".repeat(40)));
      for (const slot of manifest.ui.slots) {
        console.log(`  • ${slot.type}: ${slot.displayName}`);
      }
    }
  }
}
