import { Command } from "commander";
import { readFile } from "node:fs/promises";
import type { CompanySecret, SecretProvider } from "@paperclipai/shared";

import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "../client/common.js";

interface InstanceSecretListOptions extends BaseClientOptions {}

interface InstanceSecretCreateOptions extends BaseClientOptions {
  value?: string;
  valueFile?: string;
  provider?: string;
  description?: string;
  externalRef?: string;
}

interface InstanceSecretRotateOptions extends BaseClientOptions {
  value?: string;
  valueFile?: string;
  externalRef?: string;
}

interface InstanceSecretDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

async function readSecretValue(opts: { value?: string; valueFile?: string }): Promise<string> {
  if (opts.value !== undefined && opts.valueFile !== undefined) {
    throw new Error("Provide either --value or --value-file, not both");
  }
  if (opts.value !== undefined) return opts.value;
  if (opts.valueFile !== undefined) {
    const raw = await readFile(opts.valueFile, "utf8");
    // Strip a single trailing newline (common artifact of `... > file.txt`)
    // but preserve any trailing whitespace the operator deliberately added.
    return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  }
  throw new Error("Secret value required: pass --value <string> or --value-file <path>");
}

export function registerInstanceSecretCommands(program: Command): void {
  const instance = program.commands.find((c) => c.name() === "instance") ?? program.command("instance");
  if (!instance.description()) {
    instance.description("Instance-scoped administration commands (secrets, settings, ...)");
  }
  const secrets = instance.command("secrets").description("Manage instance-scoped secrets shared across all companies.");

  addCommonClientOptions(
    secrets
      .command("list")
      .description("List instance-scoped secrets.")
      .action(async (options: InstanceSecretListOptions) => {
        try {
          const ctx = resolveCommandContext(options);
          const data = await ctx.api.get<CompanySecret[]>("/api/instance/secrets");
          printOutput(data ?? [], { json: ctx.json, label: "Instance secrets" });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("create <name>")
      .description("Create a new instance-scoped secret. Use --value or --value-file.")
      .option("--value <string>", "Secret value (use --value-file for file input)")
      .option("--value-file <path>", "Read the secret value from a file (single trailing newline stripped)")
      .option("--provider <provider>", "Secret provider (default: server-configured)")
      .option("--description <text>", "Optional human-readable description")
      .option("--external-ref <ref>", "External provider reference (e.g. AWS Secrets Manager ARN)")
      .action(async (name: string, options: InstanceSecretCreateOptions) => {
        try {
          const ctx = resolveCommandContext(options);
          const value = await readSecretValue(options);
          const created = await ctx.api.post<CompanySecret>("/api/instance/secrets", {
            name,
            value,
            provider: options.provider as SecretProvider | undefined,
            description: options.description ?? null,
            externalRef: options.externalRef ?? null,
          });
          printOutput(created, { json: ctx.json, label: `Created instance secret ${name}` });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("rotate <id>")
      .description("Rotate the secret's value, creating a new version.")
      .option("--value <string>", "New secret value")
      .option("--value-file <path>", "Read the new secret value from a file")
      .option("--external-ref <ref>", "Updated external provider reference")
      .action(async (id: string, options: InstanceSecretRotateOptions) => {
        try {
          const ctx = resolveCommandContext(options);
          const value = await readSecretValue(options);
          const rotated = await ctx.api.post<CompanySecret>(`/api/secrets/${id}/rotate`, {
            value,
            externalRef: options.externalRef,
          });
          printOutput(rotated, { json: ctx.json, label: `Rotated secret ${id}` });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    secrets
      .command("delete <id>")
      .description("Delete an instance-scoped secret. Pass -y/--yes to skip the confirmation.")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (id: string, options: InstanceSecretDeleteOptions) => {
        try {
          const ctx = resolveCommandContext(options);
          if (!options.yes && process.stdin.isTTY) {
            const p = await import("@clack/prompts");
            const confirmed = await p.confirm({
              message: `Delete instance secret ${id}? This cannot be undone.`,
              initialValue: false,
            });
            if (!confirmed || p.isCancel(confirmed)) {
              console.log("Aborted.");
              return;
            }
          }
          const result = await ctx.api.delete<{ ok: true }>(`/api/secrets/${id}`);
          printOutput(result, { json: ctx.json, label: `Deleted secret ${id}` });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
