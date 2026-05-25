import { Command } from "commander";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import readline from "node:readline";

import {
  EncryptedFileSecretStore,
  initMasterKey,
  parseSecretsRef,
  SECRETS_REF_SCHEME,
  type SecretStore,
} from "@paperclipai/adapter-claude-local/server";

import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SecretsOptions extends BaseClientOptions {
  companyId?: string;
  rootDir?: string;
}

function resolveStore(opts: SecretsOptions): { store: EncryptedFileSecretStore; companyId: string; rootDir: string } {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  const companyId = ctx.companyId;
  if (!companyId) {
    throw new Error(
      "--company-id is required (or set a default in your CLI context profile). " +
        "Secrets are encrypted per company.",
    );
  }
  const rootDir = opts.rootDir?.trim() || path.join(os.homedir(), ".paperclip", "secrets");
  const store = new EncryptedFileSecretStore({ companyId, rootDir });
  return { store, companyId, rootDir };
}

function normalizeKey(rawKey: string): string {
  const ref = rawKey.startsWith(SECRETS_REF_SCHEME) ? rawKey : `${SECRETS_REF_SCHEME}${rawKey}`;
  const key = parseSecretsRef(ref);
  if (key === null) {
    throw new Error(
      `Invalid secret key "${rawKey}". Keys may contain letters, digits, dots, dashes, underscores, ` +
        `and slashes — no "..", absolute paths, or null bytes.`,
    );
  }
  return key;
}

async function readSecretFromStdin(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped input: read all stdin, take the first line (no trailing newline).
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const first = raw.split(/\r?\n/, 1)[0] ?? "";
    if (first.length === 0) {
      throw new Error("Secret value was empty (stdin closed without data).");
    }
    return first;
  }
  // Interactive TTY: prompt with hidden echo.
  process.stdout.write(promptText);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Patch the read-line _writeToOutput so the value is not echoed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rlAny = rl as any;
  rlAny._writeToOutput = (str: string) => {
    if (str === "\n" || str === "\r\n" || str === "\r" || str === promptText) {
      rlAny.output.write(str);
      return;
    }
    rlAny.output.write("*");
  };
  try {
    const value = await new Promise<string>((resolve) => {
      rl.question("", (answer) => resolve(answer));
    });
    process.stdout.write("\n");
    if (value.length === 0) {
      throw new Error("Secret value cannot be empty.");
    }
    return value;
  } finally {
    rl.close();
  }
}

export function registerSecretsCommands(program: Command): void {
  const group = program
    .command("secrets")
    .description(
      "Manage local encrypted secrets for claude_local adapters. " +
        "Secrets are stored at ~/.paperclip/secrets/<companyId>.json encrypted with XSalsa20-Poly1305.",
    );

  addCommonClientOptions(
    group
      .command("init")
      .description(
        "Initialize the local secrets master key at ~/.paperclip/secrets/.master.key (idempotent). " +
          "Safe to re-run.",
      )
      .option("--root-dir <path>", "Override the secrets root directory (default ~/.paperclip/secrets)")
      .action(async (opts: SecretsOptions) => {
        try {
          const rootDir = opts.rootDir?.trim() || path.join(os.homedir(), ".paperclip", "secrets");
          const result = await initMasterKey({ rootDir });
          if (opts.json) {
            printOutput(result, { json: true });
            return;
          }
          if (result.created) {
            console.log(`Created master key: ${result.path}`);
            console.log("");
            console.log("IMPORTANT: BACK THIS FILE UP TO A SAFE LOCATION.");
            console.log("Losing it makes every stored secret unrecoverable. This file holds the only");
            console.log("decryption key for everything you put with `paperclipai secrets put`.");
            console.log("");
            console.log("Mode is set to 0600 (owner-only). Do not chmod or copy it onto multi-user disks.");
          } else {
            console.log(`Master key already exists: ${result.path} (no change)`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    group
      .command("put")
      .description(
        "Encrypt a secret value under a key. The value is read from stdin (no shell history leak). " +
          "Reference it from adapterConfig as `secrets://<key>`.",
      )
      .argument("<key>", "Secret key, e.g. gh/paperclip-foundingeng")
      .option("--root-dir <path>", "Override the secrets root directory")
      .action(async (rawKey: string, opts: SecretsOptions) => {
        try {
          const { store, companyId } = resolveStore(opts);
          const key = normalizeKey(rawKey);
          const value = await readSecretFromStdin(`Secret value for ${SECRETS_REF_SCHEME}${key}: `);
          await store.put(key, value);
          if (opts.json) {
            printOutput({ stored: true, companyId, key, ref: `${SECRETS_REF_SCHEME}${key}` }, { json: true });
            return;
          }
          console.log(`Stored ${SECRETS_REF_SCHEME}${key} for company ${companyId}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    group
      .command("list")
      .description("List secret keys stored for the company.")
      .option("--root-dir <path>", "Override the secrets root directory")
      .action(async (opts: SecretsOptions) => {
        try {
          const { store, companyId } = resolveStore(opts);
          const keys = await store.list();
          if (opts.json) {
            printOutput({ companyId, keys }, { json: true });
            return;
          }
          if (keys.length === 0) {
            console.log(`No secrets stored for company ${companyId}.`);
            return;
          }
          for (const key of keys) {
            console.log(`${SECRETS_REF_SCHEME}${key}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    group
      .command("delete")
      .description("Delete a secret by key.")
      .argument("<key>", "Secret key to delete")
      .option("--root-dir <path>", "Override the secrets root directory")
      .action(async (rawKey: string, opts: SecretsOptions) => {
        try {
          const { store, companyId } = resolveStore(opts);
          const key = normalizeKey(rawKey);
          await store.delete(key);
          if (opts.json) {
            printOutput({ deleted: true, companyId, key }, { json: true });
            return;
          }
          console.log(`Deleted ${SECRETS_REF_SCHEME}${key} (if it existed) for company ${companyId}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    group
      .command("show-path")
      .description("Print the master key and per-company secrets file paths.")
      .option("--root-dir <path>", "Override the secrets root directory")
      .action(async (opts: SecretsOptions) => {
        try {
          const { store, companyId, rootDir } = resolveStore(opts);
          const payload = {
            companyId,
            rootDir,
            masterKeyPath: store.masterKeyPath,
            secretsFilePath: store.secretsFilePath,
            masterKeyExists: fs.existsSync(store.masterKeyPath),
            secretsFileExists: fs.existsSync(store.secretsFilePath),
          };
          if (opts.json) {
            printOutput(payload, { json: true });
            return;
          }
          console.log(`root            : ${payload.rootDir}`);
          console.log(`master key      : ${payload.masterKeyPath} (${payload.masterKeyExists ? "present" : "missing"})`);
          console.log(`secrets file    : ${payload.secretsFilePath} (${payload.secretsFileExists ? "present" : "missing"})`);
          console.log(`company         : ${payload.companyId}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  // Re-export the type to satisfy the linter (SecretStore unused otherwise).
  void (null as SecretStore | null);
}
