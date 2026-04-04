import "./i18n/index.js";
import { t } from "./i18n/index.js";
import { Command } from "commander";
import { onboard } from "./commands/onboard.js";
import { doctor } from "./commands/doctor.js";
import { envCommand } from "./commands/env.js";
import { configure } from "./commands/configure.js";
import { addAllowedHostname } from "./commands/allowed-hostname.js";
import { heartbeatRun } from "./commands/heartbeat-run.js";
import { runCommand } from "./commands/run.js";
import { bootstrapCeoInvite } from "./commands/auth-bootstrap-ceo.js";
import { dbBackupCommand } from "./commands/db-backup.js";
import { registerContextCommands } from "./commands/client/context.js";
import { registerCompanyCommands } from "./commands/client/company.js";
import { registerIssueCommands } from "./commands/client/issue.js";
import { registerAgentCommands } from "./commands/client/agent.js";
import { registerApprovalCommands } from "./commands/client/approval.js";
import { registerActivityCommands } from "./commands/client/activity.js";
import { registerDashboardCommands } from "./commands/client/dashboard.js";
import { registerRoutineCommands } from "./commands/routines.js";
import { registerFeedbackCommands } from "./commands/client/feedback.js";
import { applyDataDirOverride, type DataDirOptionLike } from "./config/data-dir.js";
import { loadPaperclipEnvFile } from "./config/env.js";
import { initTelemetryFromConfigFile, flushTelemetry } from "./telemetry.js";
import { registerWorktreeCommands } from "./commands/worktree.js";
import { registerPluginCommands } from "./commands/client/plugin.js";
import { registerClientAuthCommands } from "./commands/client/auth.js";
import { cliVersion } from "./version.js";

const program = new Command();

program
  .name("paperclipai")
  .description(t("commands.program_description"))
  .version(cliVersion);

program.hook("preAction", (_thisCommand, actionCommand) => {
  const options = actionCommand.optsWithGlobals() as DataDirOptionLike;
  const optionNames = new Set(actionCommand.options.map((option) => option.attributeName()));
  applyDataDirOverride(options, {
    hasConfigOption: optionNames.has("config"),
    hasContextOption: optionNames.has("context"),
  });
  loadPaperclipEnvFile(options.config);
  initTelemetryFromConfigFile(options.config);
});

program
  .command("onboard")
  .description(t("commands.onboard_description"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .option("-y, --yes", t("commands.onboard_yes_option"), false)
  .option("--run", t("commands.onboard_run_option"), false)
  .action(onboard);

program
  .command("doctor")
  .description(t("commands.doctor_description"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .option("--repair", t("commands.doctor_repair_option"))
  .alias("--fix")
  .option("-y, --yes", t("commands.doctor_yes_option"))
  .action(async (opts) => {
    await doctor(opts);
  });

program
  .command("env")
  .description(t("commands.env_description"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .action(envCommand);

program
  .command("configure")
  .description(t("commands.configure_description"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .option("-s, --section <section>", t("commands.configure_section_option"))
  .action(configure);

program
  .command("db:backup")
  .description(t("commands.db_backup_description"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .option("--dir <path>", t("commands.db_backup_dir_option"))
  .option("--retention-days <days>", t("commands.db_backup_retention_option"), (value) => Number(value))
  .option("--filename-prefix <prefix>", t("commands.db_backup_prefix_option"), "paperclip")
  .option("--json", t("commands.db_backup_json_option"))
  .action(async (opts) => {
    await dbBackupCommand(opts);
  });

program
  .command("allowed-hostname")
  .description(t("commands.allowed_hostname_description"))
  .argument("<host>", t("commands.allowed_hostname_argument"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .action(addAllowedHostname);

program
  .command("run")
  .description(t("commands.run_description"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .option("-i, --instance <id>", t("commands.run_instance_option"))
  .option("--repair", t("commands.run_repair_option"), true)
  .option("--no-repair", t("commands.run_no_repair_option"))
  .action(runCommand);

const heartbeat = program.command("heartbeat").description(t("commands.heartbeat_description"));

heartbeat
  .command("run")
  .description(t("commands.heartbeat_run_description"))
  .requiredOption("-a, --agent-id <agentId>", t("commands.heartbeat_agent_option"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .option("--context <path>", t("commands.heartbeat_context_option"))
  .option("--profile <name>", t("commands.heartbeat_profile_option"))
  .option("--api-base <url>", t("commands.heartbeat_api_base_option"))
  .option("--api-key <token>", t("commands.heartbeat_api_key_option"))
  .option(
    "--source <source>",
    t("commands.heartbeat_source_option"),
    "on_demand",
  )
  .option("--trigger <trigger>", t("commands.heartbeat_trigger_option"), "manual")
  .option("--timeout-ms <ms>", t("commands.heartbeat_timeout_option"), "0")
  .option("--json", t("commands.heartbeat_json_option"))
  .option("--debug", t("commands.heartbeat_debug_option"))
  .action(heartbeatRun);

registerContextCommands(program);
registerCompanyCommands(program);
registerIssueCommands(program);
registerAgentCommands(program);
registerApprovalCommands(program);
registerActivityCommands(program);
registerDashboardCommands(program);
registerRoutineCommands(program);
registerFeedbackCommands(program);
registerWorktreeCommands(program);
registerPluginCommands(program);

const auth = program.command("auth").description(t("commands.auth_description"));

auth
  .command("bootstrap-ceo")
  .description(t("commands.auth_bootstrap_ceo_description"))
  .option("-c, --config <path>", t("commands.onboard_config_option"))
  .option("-d, --data-dir <path>", t("commands.data_dir_help"))
  .option("--force", t("commands.auth_bootstrap_force_option"), false)
  .option("--expires-hours <hours>", t("commands.auth_bootstrap_expires_option"), (value) => Number(value))
  .option("--base-url <url>", t("commands.auth_bootstrap_base_url_option"))
  .action(bootstrapCeoInvite);

registerClientAuthCommands(auth);

async function main(): Promise<void> {
  let failed = false;
  try {
    await program.parseAsync();
  } catch (err) {
    failed = true;
    console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await flushTelemetry();
  }

  if (failed) {
    process.exit(1);
  }
}

void main();
