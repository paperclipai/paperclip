import { Command } from "commander";
import {
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
  type CompanySecret,
  type SecretProviderDescriptor,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SecretListOptions extends BaseClientOptions {
  companyId?: string;
}

interface SecretProvidersOptions extends BaseClientOptions {
  companyId?: string;
}

interface SecretCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  valueStdin?: boolean;
  provider?: string;
  description?: string;
  externalRef?: string;
}

interface SecretRotateOptions extends BaseClientOptions {
  valueStdin?: boolean;
  externalRef?: string;
}

interface SecretUpdateOptions extends BaseClientOptions {
  name?: string;
  description?: string;
  externalRef?: string;
}

interface SecretDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

async function readStdinValue(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

export function registerSecretCommands(program: Command): void {
  const secret = program.command("secret").description("Company secret operations");

  addCommonClientOptions(
    secret
      .command("list")
      .description("List secrets for a company (metadata only, never values)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<CompanySecret[]>(
              `/api/companies/${ctx.companyId}/secrets`,
            )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                name: row.name,
                provider: row.provider,
                latestVersion: row.latestVersion,
                externalRef: row.externalRef ?? null,
                description: row.description ?? null,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    secret
      .command("providers")
      .description("List configured secret providers for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: SecretProvidersOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<SecretProviderDescriptor[]>(
              `/api/companies/${ctx.companyId}/secret-providers`,
            )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }

          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const row of rows) {
            console.log(
              formatInlineRecord({
                id: row.id,
                label: row.label,
                requiresExternalRef: row.requiresExternalRef,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    secret
      .command("create")
      .description("Create a new secret. The value is read from stdin via --value-stdin to keep it out of process argv and shell history.")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Secret name (env var key)")
      .requiredOption("--value-stdin", "Read secret value from stdin (the only supported channel)")
      .option("--provider <provider>", "Secret provider (local_encrypted, aws_secrets_manager, gcp_secret_manager, vault)")
      .option("--description <text>", "Description")
      .option("--external-ref <ref>", "External reference (for non-local providers)")
      .action(async (opts: SecretCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });

          if (!opts.valueStdin) {
            throw new Error("--value-stdin is required. Pipe the secret value on stdin.");
          }
          const value = await readStdinValue();
          if (value.length === 0) {
            throw new Error("Secret value read from stdin was empty.");
          }

          const payload: Record<string, unknown> = { name: opts.name, value };
          if (opts.provider !== undefined) payload.provider = opts.provider;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.externalRef !== undefined) payload.externalRef = opts.externalRef;

          const parsed = createSecretSchema.parse(payload);
          const row = await ctx.api.post<CompanySecret>(
            `/api/companies/${ctx.companyId}/secrets`,
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
    secret
      .command("rotate")
      .description("Rotate a secret to a new value. The new value is read from stdin via --value-stdin to keep it out of process argv and shell history.")
      .argument("<secretId>", "Secret ID")
      .requiredOption("--value-stdin", "Read new value from stdin (the only supported channel)")
      .option("--external-ref <ref>", "Updated external reference")
      .action(async (secretId: string, opts: SecretRotateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          if (!opts.valueStdin) {
            throw new Error("--value-stdin is required. Pipe the new secret value on stdin.");
          }
          const value = await readStdinValue();
          if (value.length === 0) {
            throw new Error("Rotation value read from stdin was empty.");
          }

          const payload: Record<string, unknown> = { value };
          if (opts.externalRef !== undefined) payload.externalRef = opts.externalRef;

          const parsed = rotateSecretSchema.parse(payload);
          const row = await ctx.api.post<CompanySecret>(
            `/api/secrets/${encodeURIComponent(secretId)}/rotate`,
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
    secret
      .command("update")
      .description("Update secret metadata (does not rotate the value)")
      .argument("<secretId>", "Secret ID")
      .option("--name <name>", "New name")
      .option("--description <text>", "New description")
      .option("--external-ref <ref>", "New external reference")
      .action(async (secretId: string, opts: SecretUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.name !== undefined) payload.name = opts.name;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.externalRef !== undefined) payload.externalRef = opts.externalRef;

          const parsed = updateSecretSchema.parse(payload);
          const row = await ctx.api.patch<CompanySecret>(
            `/api/secrets/${encodeURIComponent(secretId)}`,
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
    secret
      .command("delete")
      .description("Delete a secret")
      .argument("<secretId>", "Secret ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (secretId: string, opts: SecretDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const { confirm } = await import("@clack/prompts");
            const answer = await confirm({
              message: `Delete secret ${secretId}? This cannot be undone and any references will break.`,
              initialValue: false,
            });
            if (answer !== true) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<{ ok: boolean }>(
            `/api/secrets/${encodeURIComponent(secretId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
