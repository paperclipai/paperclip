import { Command } from "commander";
import type { CompanySecret } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SecretListOptions extends BaseClientOptions {}
interface SecretGetOptions extends BaseClientOptions {}
interface SecretSetOptions extends BaseClientOptions {
  description?: string;
  provider?: string;
}
interface SecretDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

export function registerSecretCommands(program: Command): void {
  const secrets = program.command("secrets").description("Company secrets management");

  addCommonClientOptions(
    secrets
      .command("list")
      .description("List all secrets for a company")
      .action(async (opts: SecretListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<CompanySecret[]>(
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
                version: row.latestVersion,
                description: row.description ?? "",
                createdAt: String(row.createdAt),
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    secrets
      .command("get <name>")
      .description("Get a secret by name (metadata only, values are never exposed)")
      .action(async (name: string, opts: SecretGetOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<CompanySecret[]>(
            `/api/companies/${ctx.companyId}/secrets`,
          )) ?? [];
          const match = rows.find((s) => s.name === name);

          if (!match) {
            console.error(`Secret "${name}" not found.`);
            process.exit(1);
          }

          if (ctx.json) {
            printOutput(match, { json: true });
            return;
          }

          console.log(
            formatInlineRecord({
              id: match.id,
              name: match.name,
              provider: match.provider,
              version: match.latestVersion,
              description: match.description ?? "",
              createdAt: String(match.createdAt),
            }),
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    secrets
      .command("set <name> <value>")
      .description("Create a secret or rotate its value if it already exists")
      .option("--description <text>", "Secret description")
      .option("--provider <provider>", "Secret provider (default: local_encrypted)")
      .action(async (name: string, value: string, opts: SecretSetOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<CompanySecret[]>(
            `/api/companies/${ctx.companyId}/secrets`,
          )) ?? [];
          const existing = rows.find((s) => s.name === name);

          let result: CompanySecret;
          if (existing) {
            result = (await ctx.api.post<CompanySecret>(
              `/api/secrets/${existing.id}/rotate`,
              { value },
            ))!;
          } else {
            result = (await ctx.api.post<CompanySecret>(
              `/api/companies/${ctx.companyId}/secrets`,
              {
                name,
                value,
                description: opts.description ?? null,
                provider: opts.provider,
              },
            ))!;
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(
            `${existing ? "Rotated" : "Created"} secret "${result.name}" (${result.id})`,
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    secrets
      .command("delete <name>")
      .description("Delete a secret by name")
      .option("-y, --yes", "Skip confirmation")
      .action(async (name: string, opts: SecretDeleteOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<CompanySecret[]>(
            `/api/companies/${ctx.companyId}/secrets`,
          )) ?? [];
          const match = rows.find((s) => s.name === name);

          if (!match) {
            console.error(`Secret "${name}" not found.`);
            process.exit(1);
          }

          if (!opts.yes) {
            const { createInterface } = await import("node:readline");
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise<string>((resolve) =>
              rl.question(`Delete secret "${name}" (${match.id})? [y/N] `, resolve),
            );
            rl.close();
            if (answer.toLowerCase() !== "y") {
              console.log("Aborted.");
              return;
            }
          }

          await ctx.api.delete(`/api/secrets/${match.id}`);

          if (ctx.json) {
            printOutput({ ok: true, id: match.id, name }, { json: true });
            return;
          }

          console.log(`Deleted secret "${name}" (${match.id})`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
