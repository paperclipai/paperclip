import type { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  migrateAssetsToS3,
  publishRecoveryManifest,
  runRecoveryDrill,
} from "./recovery-lib.js";
import { printPaperclipCliBanner } from "../utils/banner.js";

const DATA_DIR_OPTION_HELP =
  "Paperclip data directory root (isolates state from ~/.paperclip)";

type RecoveryPublishOptions = {
  config?: string;
  dataDir?: string;
  backupFile?: string;
  statusPath?: string;
  json?: boolean;
};

type RecoveryCutoverOptions = {
  config?: string;
  dataDir?: string;
  statusPath?: string;
  switchProvider?: boolean;
  json?: boolean;
};

type RecoveryDrillOptions = {
  config?: string;
  dataDir?: string;
  statusPath?: string;
  manifestKey?: string;
  restoreUrl: string;
  restoreKeyFile?: string;
  json?: boolean;
};

async function recoveryPublishCommand(opts: RecoveryPublishOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip recovery:publish ")));
  const spinner = p.spinner();
  spinner.start("Publishing recovery manifest...");
  try {
    const result = await publishRecoveryManifest({
      configPath: opts.config,
      statusPath: opts.statusPath,
      backupFile: opts.backupFile,
    });
    spinner.stop(`Published ${result.manifest.manifestId}`);
    p.log.message(pc.dim(`Manifest: ${result.manifest.manifestObjectKey}`));
    p.log.message(pc.dim(`Status file: ${result.statusPath}`));
    p.log.message(pc.dim(`Recovery state: ${result.status.state}`));
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    p.outro(pc.green("Recovery manifest published."));
  } catch (error) {
    spinner.stop(pc.red("Recovery publish failed."));
    throw error;
  }
}

async function recoveryCutoverCommand(opts: RecoveryCutoverOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip recovery:cutover-assets ")));
  const spinner = p.spinner();
  spinner.start("Migrating local assets into S3...");
  try {
    const result = await migrateAssetsToS3({
      configPath: opts.config,
      statusPath: opts.statusPath,
      switchProvider: opts.switchProvider === true,
    });
    spinner.stop(`Migrated ${result.migratedAssets} asset(s)`);
    p.log.message(pc.dim(`Migrated bytes: ${result.migratedBytes}`));
    p.log.message(pc.dim(`Skipped assets: ${result.skippedAssets}`));
    p.log.message(pc.dim(`Switched provider: ${result.switchedProvider ? "yes" : "no"}`));
    p.log.message(pc.dim(`Status file: ${result.statusPath}`));
    p.log.message(pc.dim(`Recovery state: ${result.status.state}`));
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    p.outro(pc.green("Asset cutover finished."));
  } catch (error) {
    spinner.stop(pc.red("Asset cutover failed."));
    throw error;
  }
}

async function recoveryDrillCommand(opts: RecoveryDrillOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip recovery:drill ")));
  const spinner = p.spinner();
  spinner.start("Running restore drill...");
  try {
    const result = await runRecoveryDrill({
      configPath: opts.config,
      statusPath: opts.statusPath,
      manifestObjectKey: opts.manifestKey,
      restoreConnectionString: opts.restoreUrl,
      restoreKeyFilePath: opts.restoreKeyFile,
    });
    spinner.stop(`Drill ${result.drill.status}`);
    p.log.message(pc.dim(`Drill id: ${result.drill.drillId}`));
    p.log.message(pc.dim(`Manifest id: ${result.drill.manifestId}`));
    p.log.message(pc.dim(`Evidence: ${result.drill.evidenceObjectKey ?? "none"}`));
    p.log.message(pc.dim(`Status file: ${result.statusPath}`));
    p.log.message(pc.dim(`Recovery state: ${result.status.state}`));
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    p.outro(pc.green("Restore drill finished."));
  } catch (error) {
    spinner.stop(pc.red("Restore drill failed."));
    throw error;
  }
}

export function registerRecoveryCommands(program: Command): void {
  program
    .command("recovery:publish")
    .description("Publish the latest local DB backup, config snapshot, and key snapshot to the recovery vault")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--backup-file <path>", "Use a specific local backup file instead of auto-detecting the newest one")
    .option("--status-path <path>", "Override the local recovery status file path")
    .option("--json", "Print the publish result as JSON")
    .action(async (opts) => {
      await recoveryPublishCommand(opts);
    });

  program
    .command("recovery:cutover-assets")
    .description("Copy local asset objects into S3 and optionally switch the live storage provider")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--status-path <path>", "Override the local recovery status file path")
    .option("--switch-provider", "Switch storage.provider to s3 after the copy completes", false)
    .option("--json", "Print the cutover result as JSON")
    .action(async (opts) => {
      await recoveryCutoverCommand(opts);
    });

  program
    .command("recovery:drill")
    .description("Restore a published recovery manifest into a clean target and record drill status")
    .requiredOption("--restore-url <url>", "Connection string for the clean restore target database")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", DATA_DIR_OPTION_HELP)
    .option("--status-path <path>", "Override the local recovery status file path")
    .option("--manifest-key <key>", "Recovery manifest object key to drill; defaults to the latest published manifest")
    .option("--restore-key-file <path>", "Optional destination for the decrypted master key during the drill")
    .option("--json", "Print the drill result as JSON")
    .action(async (opts) => {
      await recoveryDrillCommand(opts as RecoveryDrillOptions);
    });
}
