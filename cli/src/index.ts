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
import { cliT, localizeCliMessage } from "./i18n.js";

const program = new Command();
const { t } = cliT();
const DATA_DIR_OPTION_HELP = t("cli.dataDirOption");

program
  .name("paperclipai")
  .description(t("cli.programDescription"))
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
  .description(t("cli.onboardDescription"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--bind <mode>", t("cli.bindMode"))
  .option("-y, --yes", t("cli.acceptQuickstartDefaults"), false)
  .option("--run", t("cli.startAfterSavingConfig"), false)
  .action(onboard);

program
  .command("doctor")
  .description(t("cli.doctorDescription"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--repair", t("cli.repairIssues"))
  .alias("--fix")
  .option("-y, --yes", t("cli.skipRepairConfirmationPrompts"))
  .action(async (opts) => {
    await doctor(opts);
  });

program
  .command("env")
  .description(t("cli.envDescription"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(envCommand);

program
  .command("configure")
  .description(t("cli.configureDescription"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("-s, --section <section>", t("cli.sectionToConfigure"))
  .action(configure);

program
  .command("db:backup")
  .description(t("cli.dbBackupDescription"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--dir <path>", t("cli.backupOutputDir"))
  .option("--retention-days <days>", t("cli.retentionDays"), (value) => Number(value))
  .option("--filename-prefix <prefix>", t("cli.backupFilenamePrefix"), "paperclip")
  .option("--json", t("cli.printJson"))
  .action(async (opts) => {
    await dbBackupCommand(opts);
  });

program
  .command("allowed-hostname")
  .description(t("cli.allowedHostnameDescription"))
  .argument("<host>", t("cli.hostnameToAllow"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .action(addAllowedHostname);

program
  .command("run")
  .description(t("cli.runDescription"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("-i, --instance <id>", t("cli.localInstanceId"))
  .option("--bind <mode>", t("cli.bindMode"))
  .option("--repair", t("cli.repairIssues"), true)
  .option("--no-repair", t("cli.disableAutomaticRepairs"))
  .action(runCommand);

const heartbeat = program.command("heartbeat").description(t("cli.heartbeatDescription"));

heartbeat
  .command("run")
  .description(t("cli.heartbeatRunDescription"))
  .requiredOption("-a, --agent-id <agentId>", t("cli.agentIdToInvoke"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--context <path>", t("cli.pathToContextFile"))
  .option("--profile <name>", t("cli.contextProfileName"))
  .option("--api-base <url>", t("cli.apiBaseUrl"))
  .option("--api-key <token>", t("cli.apiKeyBearer"))
  .option(
    "--source <source>",
    t("cli.invocationSource"),
    "on_demand",
  )
  .option("--trigger <trigger>", t("cli.triggerDetail"), "manual")
  .option("--timeout-ms <ms>", t("cli.timeoutMs"), "0")
  .option("--json", t("cli.outputRawJson"))
  .option("--debug", t("cli.showRawAdapterJson"))
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

const auth = program.command("auth").description(t("cli.authDescription"));

auth
  .command("bootstrap-ceo")
  .description(t("cli.bootstrapCeoDescription"))
  .option("-c, --config <path>", t("cli.pathToConfig"))
  .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
  .option("--force", t("cli.forceCreateInvite"), false)
  .option("--expires-hours <hours>", t("cli.inviteExpirationHours"), (value) => Number(value))
  .option("--base-url <url>", t("cli.publicBaseUrl"))
  .action(bootstrapCeoInvite);

registerClientAuthCommands(auth);

async function main(): Promise<void> {
  let failed = false;
  try {
    await program.parseAsync();
  } catch (err) {
    failed = true;
    console.error(err instanceof Error ? localizeCliMessage(err.message) : String(err));
  } finally {
    await flushTelemetry();
  }

  if (failed) {
    process.exit(1);
  }
}

void main();
