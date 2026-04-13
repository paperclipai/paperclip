import { constants, chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  applyPendingMigrations,
  createDb,
  resolveMigrationConnection,
} from "@paperclipai/db";
import {
  decodeLocalEncryptedMasterKey,
  formatLocalEncryptedMasterKey,
  generateLocalEncryptedMasterKey,
  readLocalEncryptedMasterKeyFile,
  secretService,
  type LocalEncryptedMasterKeyRekeyResult,
} from "@paperclipai/server/secrets";
import { resolveDefaultSecretsKeyFilePath } from "../config/home.js";
import { loadPaperclipEnvFile } from "../config/env.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { resolveRuntimeLikePath } from "../utils/path-resolver.js";

type ClosableDb = ReturnType<typeof createDb> & {
  $client?: {
    end?: (options?: { timeout?: number }) => Promise<void>;
  };
};

type GenerateLocalMasterKeyOptions = {
  output: string;
};

type RekeyLocalMasterKeyOptions = {
  config?: string;
  dataDir?: string;
  oldKeyFile?: string;
  newKeyFile?: string;
  companyId?: string;
  apply?: boolean;
  confirmBackup?: boolean;
  activateNewKey?: boolean;
  json?: boolean;
};

type MasterKeySource = {
  key: Buffer;
  source: string;
  filePath: string | null;
};

type ActivationResult = {
  activeKeyFilePath: string;
  backupKeyFilePath: string;
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveKeyFilePath(rawPath: string, configPath: string): string {
  return resolveRuntimeLikePath(rawPath, configPath);
}

function loadMasterKeyFromFile(rawPath: string, configPath: string): MasterKeySource {
  const filePath = resolveKeyFilePath(rawPath, configPath);
  return {
    key: readLocalEncryptedMasterKeyFile(filePath),
    source: filePath,
    filePath,
  };
}

function loadOldMasterKey(options: RekeyLocalMasterKeyOptions, configPath: string): MasterKeySource {
  if (options.oldKeyFile) {
    return loadMasterKeyFromFile(options.oldKeyFile, configPath);
  }

  const inlineMasterKey = nonEmpty(process.env.PAPERCLIP_SECRETS_MASTER_KEY);
  if (inlineMasterKey) {
    const decoded = decodeLocalEncryptedMasterKey(inlineMasterKey);
    if (!decoded) {
      throw new Error(
        "PAPERCLIP_SECRETS_MASTER_KEY is invalid (expected 32-byte base64, 64-char hex, or raw 32-char string)",
      );
    }
    return {
      key: decoded,
      source: "PAPERCLIP_SECRETS_MASTER_KEY",
      filePath: null,
    };
  }

  const config = readConfig(configPath);
  if (config?.secrets.provider && config.secrets.provider !== "local_encrypted") {
    throw new Error(
      `Configured secrets provider is ${config.secrets.provider}; local master-key rekey only supports local_encrypted.`,
    );
  }

  const configuredPath =
    nonEmpty(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE) ??
    config?.secrets.localEncrypted.keyFilePath ??
    resolveDefaultSecretsKeyFilePath();
  return loadMasterKeyFromFile(configuredPath, configPath);
}

async function closeDb(db: ClosableDb): Promise<void> {
  await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
}

function makeBackupPath(activeKeyFilePath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${activeKeyFilePath}.before-rekey-${stamp}`;
}

function activateNewKeyFile(
  oldKeyFilePath: string,
  newKeyFilePath: string,
  newMasterKey: Buffer,
): ActivationResult {
  const activeKeyFilePath = path.resolve(oldKeyFilePath);
  const resolvedNewKeyFilePath = path.resolve(newKeyFilePath);
  if (activeKeyFilePath === resolvedNewKeyFilePath) {
    throw new Error("--activate-new-key requires --new-key-file to be different from the active key file");
  }

  const backupKeyFilePath = makeBackupPath(activeKeyFilePath);
  copyFileSync(activeKeyFilePath, backupKeyFilePath, constants.COPYFILE_EXCL);
  try {
    chmodSync(backupKeyFilePath, 0o600);
  } catch {
    // Best effort; the source file's permissions were preserved by copyFileSync.
  }

  const tempKeyFilePath = `${activeKeyFilePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempKeyFilePath, formatLocalEncryptedMasterKey(newMasterKey), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      chmodSync(tempKeyFilePath, 0o600);
    } catch {
      // Best effort on filesystems that do not support chmod.
    }
    renameSync(tempKeyFilePath, activeKeyFilePath);
  } catch (error) {
    if (existsSync(tempKeyFilePath)) {
      try {
        rmSync(tempKeyFilePath, { force: true });
      } catch {
        // ignored
      }
    }
    throw error;
  }

  return { activeKeyFilePath, backupKeyFilePath };
}

function printRekeyResult(
  result: LocalEncryptedMasterKeyRekeyResult,
  activation: ActivationResult | null,
): void {
  const action = result.dryRun ? "Dry run validated" : "Rekeyed";
  console.log(
    `${action} ${result.versionCount} local_encrypted secret version(s) across ` +
      `${result.secretCount} secret(s) in ${result.companyCount} compan${result.companyCount === 1 ? "y" : "ies"}.`,
  );
  if (result.dryRun) {
    console.log(pc.dim("Re-run with --apply --confirm-backup to persist the rekey."));
  }
  if (activation) {
    console.log(`Activated new master key file: ${activation.activeKeyFilePath}`);
    console.log(`Backed up previous master key file: ${activation.backupKeyFilePath}`);
  }
}

export async function generateLocalMasterKeyCommand(
  options: GenerateLocalMasterKeyOptions,
): Promise<void> {
  const outputPath = path.resolve(options.output);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, formatLocalEncryptedMasterKey(generateLocalEncryptedMasterKey()), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    chmodSync(outputPath, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  console.log(`Generated local encrypted secrets master key file: ${outputPath}`);
}

export async function rekeyLocalMasterKeyCommand(
  options: RekeyLocalMasterKeyOptions,
): Promise<void> {
  const configPath = resolveConfigPath(options.config);
  loadPaperclipEnvFile(configPath);
  const apply = options.apply === true;

  if (!options.newKeyFile) {
    throw new Error("Pass --new-key-file with a permission-restricted file containing the new master key.");
  }
  if (apply && !options.confirmBackup) {
    throw new Error("--apply requires --confirm-backup after you have backed up the database and old key file.");
  }
  if (!apply && options.activateNewKey) {
    throw new Error("--activate-new-key requires --apply.");
  }

  const oldMasterKey = loadOldMasterKey(options, configPath);
  const newKeyFilePath = resolveKeyFilePath(options.newKeyFile, configPath);
  const newMasterKey = readLocalEncryptedMasterKeyFile(newKeyFilePath);
  if (oldMasterKey.key.equals(newMasterKey)) {
    throw new Error("Old and new local secrets master keys must differ.");
  }
  if (options.activateNewKey && !oldMasterKey.filePath) {
    throw new Error("--activate-new-key requires the old key to come from a key file, not PAPERCLIP_SECRETS_MASTER_KEY.");
  }

  const connection = await resolveMigrationConnection();
  let db: ClosableDb | null = null;
  try {
    await applyPendingMigrations(connection.connectionString);
    db = createDb(connection.connectionString) as ClosableDb;

    const result = await secretService(db).rekeyLocalEncryptedMasterKey({
      oldMasterKey: oldMasterKey.key,
      newMasterKey,
      dryRun: !apply,
      companyId: options.companyId,
      actorId: "paperclipai-cli",
    });

    let activation: ActivationResult | null = null;
    if (apply && options.activateNewKey && oldMasterKey.filePath) {
      activation = activateNewKeyFile(oldMasterKey.filePath, newKeyFilePath, newMasterKey);
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ...result,
            oldKeySource: oldMasterKey.source,
            newKeyFilePath,
            activation,
            databaseSource: connection.source,
          },
          null,
          2,
        ),
      );
      return;
    }

    printRekeyResult(result, activation);
  } finally {
    if (db) await closeDb(db);
    await connection.stop();
  }
}

export function registerSecretsCommands(program: Command): void {
  const secrets = program.command("secrets").description("Local secrets maintenance commands");

  secrets
    .command("generate-local-master-key")
    .description("Generate a permission-restricted local_encrypted master key file")
    .requiredOption("--output <path>", "Destination key file path")
    .action(async (opts: GenerateLocalMasterKeyOptions) => {
      try {
        await generateLocalMasterKeyCommand(opts);
      } catch (error) {
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  secrets
    .command("rekey-local-master-key")
    .description("Re-encrypt local_encrypted secret versions with a new local master key")
    .option("-c, --config <path>", "Path to config file")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--old-key-file <path>", "Old master key file; defaults to configured local_encrypted key")
    .requiredOption("--new-key-file <path>", "New master key file")
    .option("-C, --company-id <id>", "Limit the rekey to one company")
    .option("--apply", "Persist the rekey; default is a dry-run validation", false)
    .option("--confirm-backup", "Acknowledge that database and key-file backups exist", false)
    .option("--activate-new-key", "Replace the active key file with the new key after a successful apply", false)
    .option("--json", "Output raw JSON", false)
    .action(async (opts: RekeyLocalMasterKeyOptions) => {
      try {
        await rekeyLocalMasterKeyCommand(opts);
      } catch (error) {
        console.error(pc.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
