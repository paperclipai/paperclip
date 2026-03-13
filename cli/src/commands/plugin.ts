import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Command } from "commander";
import {
  describePluginConfig,
  doctorPlugins,
  getPluginConfig,
  installLocalPlugin,
  listInstalledPlugins,
  loadPlugins,
  restartPlugin,
  setPluginConfig,
  setPluginEnabled,
  uninstallPlugin,
  updatePluginConfig,
} from "./plugin-lib.js";

type PluginCommonOptions = {
  instance?: string;
  json?: boolean;
};

type PluginInstallOptions = PluginCommonOptions & {
  path?: string;
  skipBootstrap?: boolean;
};

type PluginUninstallOptions = PluginCommonOptions & {
  purgeData?: boolean;
};

type PluginDoctorOptions = PluginCommonOptions & {
  pluginId?: string;
  restartOnFail?: boolean;
};

type PluginLoadOptions = PluginCommonOptions & {
  pluginId?: string;
};

type PluginEnableOptions = PluginCommonOptions;

type PluginConfigSetOptions = PluginCommonOptions & {
  valueJson?: string;
  restart?: boolean;
};

function printPluginSummary(plugin: ReturnType<typeof listInstalledPlugins>[number]): void {
  const statusColor =
    plugin.status === "ready" ? pc.green : plugin.status === "disabled" ? pc.yellow : pc.red;
  const enabledText = plugin.enabled ? pc.green("enabled") : pc.yellow("disabled");
  console.log(
    `- ${plugin.pluginId} ${pc.dim(`(${plugin.packageVersion})`)} ${statusColor(plugin.status)} ${pc.dim("/")} ${enabledText}`,
  );
  if (plugin.lastError) {
    console.log(pc.dim(`  error: ${plugin.lastError}`));
  }
}

async function pluginListCommand(opts: PluginCommonOptions): Promise<void> {
  const plugins = listInstalledPlugins(opts);
  if (opts.json) {
    console.log(JSON.stringify({ plugins }, null, 2));
    return;
  }

  if (plugins.length === 0) {
    p.log.info("No plugins installed.");
    return;
  }

  p.log.info(`Installed plugins (${plugins.length}):`);
  for (const plugin of plugins) {
    printPluginSummary(plugin);
  }
}

async function pluginInstallCommand(localPath: string, opts: PluginInstallOptions): Promise<void> {
  const record = await installLocalPlugin(localPath, {
    instance: opts.instance,
    json: opts.json,
    skipBootstrap: opts.skipBootstrap,
  });

  if (opts.json) {
    console.log(JSON.stringify({ plugin: record }, null, 2));
    return;
  }

  p.log.success(`Installed plugin ${record.pluginId} (${record.packageVersion})`);
  printPluginSummary(record);
}

async function pluginUninstallCommand(pluginId: string, opts: PluginUninstallOptions): Promise<void> {
  const record = await uninstallPlugin(pluginId, {
    instance: opts.instance,
    json: opts.json,
    purgeData: opts.purgeData,
  });

  if (opts.json) {
    console.log(JSON.stringify({ removed: record }, null, 2));
    return;
  }

  p.log.success(`Uninstalled plugin ${record.pluginId}`);
  if (opts.purgeData) {
    p.log.message(pc.dim("Plugin data directory removed."));
  }
}

async function pluginDoctorCommand(opts: PluginDoctorOptions): Promise<void> {
  const results = await doctorPlugins({
    instance: opts.instance,
    json: opts.json,
    pluginId: opts.pluginId,
    restartOnFail: opts.restartOnFail,
  });

  if (opts.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  if (results.length === 0) {
    p.log.info("No plugins installed.");
    return;
  }

  const failed = results.filter((item) => !item.ok);
  for (const item of results) {
    if (item.ok) {
      p.log.success(`${item.pluginId}: ${item.status}`);
    } else {
      p.log.error(`${item.pluginId}: ${item.error ?? "unknown error"}`);
    }
  }

  if (failed.length > 0) {
    throw new Error(`${failed.length} plugin(s) failed doctor checks.`);
  }
}

async function pluginLoadCommand(opts: PluginLoadOptions): Promise<void> {
  const results = await loadPlugins({
    instance: opts.instance,
    json: opts.json,
    pluginId: opts.pluginId,
  });

  if (opts.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  for (const item of results) {
    if (item.status === "ready") {
      p.log.success(`${item.pluginId}: loaded`);
    } else if (item.status === "disabled") {
      p.log.warn(`${item.pluginId}: disabled`);
    } else {
      p.log.error(`${item.pluginId}: ${item.error ?? "load failed"}`);
    }
  }

  const failures = results.filter((item) => item.status === "error");
  if (failures.length > 0) {
    throw new Error(`${failures.length} plugin(s) failed to load.`);
  }
}

async function pluginRestartCommand(pluginId: string, opts: PluginCommonOptions): Promise<void> {
  const result = await restartPlugin(pluginId, opts);
  const plugin = listInstalledPlugins(opts).find((item) => item.pluginId === pluginId);

  if (opts.json) {
    if (!plugin) {
      throw new Error(`Plugin not found after restart: ${pluginId}`);
    }
    console.log(JSON.stringify({ result, plugin }, null, 2));
    return;
  }

  if (result.status === "ready") {
    p.log.success(`${pluginId}: restarted`);
    return;
  }

  throw new Error(`${pluginId}: ${result.error ?? "restart failed"}`);
}

async function pluginEnableCommand(pluginId: string, opts: PluginEnableOptions): Promise<void> {
  const record = await setPluginEnabled(pluginId, true, opts);
  if (opts.json) {
    console.log(JSON.stringify({ plugin: record }, null, 2));
    return;
  }
  p.log.success(`Enabled plugin ${record.pluginId}`);
}

async function pluginDisableCommand(pluginId: string, opts: PluginEnableOptions): Promise<void> {
  const record = await setPluginEnabled(pluginId, false, opts);
  if (opts.json) {
    console.log(JSON.stringify({ plugin: record }, null, 2));
    return;
  }
  p.log.success(`Disabled plugin ${record.pluginId}`);
}

async function pluginConfigGetCommand(pluginId: string, opts: PluginCommonOptions): Promise<void> {
  const config = getPluginConfig(pluginId, opts);
  console.log(JSON.stringify({ pluginId, config }, null, 2));
}

async function pluginConfigDescribeCommand(pluginId: string, opts: PluginCommonOptions): Promise<void> {
  const described = await describePluginConfig(pluginId, opts);
  console.log(JSON.stringify(described, null, 2));
}

async function pluginConfigSetCommand(
  pluginId: string,
  opts: PluginConfigSetOptions,
): Promise<void> {
  if (!opts.valueJson) {
    throw new Error("Missing required --value-json <value> for config set.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.valueJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for --value-json: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config payload must be a JSON object.");
  }

  const result = await updatePluginConfig(pluginId, parsed as Record<string, unknown>, {
    instance: opts.instance,
    json: opts.json,
    restart: opts.restart,
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  p.log.success(`Updated config for plugin ${result.plugin.pluginId}`);
  if (opts.restart) {
    p.log.message(pc.dim(`Restart status: ${result.restartResult?.status ?? "unknown"}`));
  }
}

export function registerPluginCommands(program: Command): void {
  const plugin = program.command("plugin").description("Manage Paperclip host plugins");

  plugin
    .command("list")
    .description("List installed plugins")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--json", "Print JSON output")
    .action(pluginListCommand);

  plugin
    .command("install")
    .description("Install plugin from local package path")
    .argument("<path>", "Local plugin package directory path")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--skip-bootstrap", "Skip initialize/health bootstrap after validation", false)
    .option("--json", "Print JSON output")
    .action(pluginInstallCommand);

  plugin
    .command("uninstall")
    .description("Uninstall plugin by manifest id")
    .argument("<pluginId>", "Plugin manifest id")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--purge-data", "Also remove ~/.paperclip/.../data/plugins/<plugin-id>", false)
    .option("--json", "Print JSON output")
    .action(pluginUninstallCommand);

  plugin
    .command("doctor")
    .description("Validate installed plugins and run worker load + health checks")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--plugin-id <id>", "Run doctor for one plugin id")
    .option("--restart-on-fail", "Attempt one restart if load check fails", false)
    .option("--json", "Print JSON output")
    .action(pluginDoctorCommand);

  plugin
    .command("load")
    .description("Load one plugin or all enabled plugins in current host process")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--plugin-id <id>", "Load one plugin id")
    .option("--json", "Print JSON output")
    .action(pluginLoadCommand);

  plugin
    .command("restart")
    .description("Restart one plugin in current host process")
    .argument("<pluginId>", "Plugin manifest id")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--json", "Print JSON output")
    .action(pluginRestartCommand);

  plugin
    .command("enable")
    .description("Enable a plugin")
    .argument("<pluginId>", "Plugin manifest id")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--json", "Print JSON output")
    .action(pluginEnableCommand);

  plugin
    .command("disable")
    .description("Disable a plugin")
    .argument("<pluginId>", "Plugin manifest id")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--json", "Print JSON output")
    .action(pluginDisableCommand);

  const pluginConfig = plugin.command("config").description("Manage plugin config JSON payload");

  pluginConfig
    .command("get")
    .description("Get plugin config JSON")
    .argument("<pluginId>", "Plugin manifest id")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--json", "Print JSON output")
    .action(pluginConfigGetCommand);

  pluginConfig
    .command("describe")
    .description("Describe plugin config schema + current values")
    .argument("<pluginId>", "Plugin manifest id")
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--json", "Print JSON output")
    .action(pluginConfigDescribeCommand);

  pluginConfig
    .command("set")
    .description("Set plugin config JSON")
    .argument("<pluginId>", "Plugin manifest id")
    .requiredOption("--value-json <value>", "JSON object string for plugin config")
    .option("--restart", "Restart plugin after config update", false)
    .option("-i, --instance <id>", "Paperclip instance id")
    .option("--json", "Print JSON output")
    .action(pluginConfigSetCommand);
}
