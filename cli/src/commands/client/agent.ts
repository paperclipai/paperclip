import { Command } from "commander";
import type { Agent } from "@paperclipai/shared";
import {
  removeMaintainerOnlySkillSymlinks,
  resolvePaperclipSkillsDir,
} from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AgentListOptions extends BaseClientOptions {
  companyId?: string;
}

interface AgentCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  role?: string;
  title?: string;
  adapterType?: string;
  reportsTo?: string;
  adapterConfig?: string;
  runtimeConfig?: string;
  budget?: string;
  capabilities?: string;
}

interface AgentUpdateOptions extends BaseClientOptions {
  name?: string;
  role?: string;
  status?: string;
  title?: string;
  adapterType?: string;
  reportsTo?: string;
  adapterConfig?: string;
  runtimeConfig?: string;
  budget?: string;
  capabilities?: string;
}

interface AgentDeleteOptions extends BaseClientOptions {
  yes?: boolean;
  confirm?: string;
}

interface AgentLocalCliOptions extends BaseClientOptions {
  companyId?: string;
  keyName?: string;
  installSkills?: boolean;
}

interface CreatedAgentKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

interface SkillsInstallSummary {
  tool: "codex" | "claude";
  target: string;
  linked: string[];
  removed: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

async function parseJsonOption(value: string): Promise<Record<string, unknown>> {
  if (value.startsWith("@")) {
    const filePath = path.resolve(value.slice(1));
    try {
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Failed to read/parse JSON from file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON string: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function codexSkillsHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".codex");
  return path.join(base, "skills");
}

function claudeSkillsHome(): string {
  const fromEnv = process.env.CLAUDE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(os.homedir(), ".claude");
  return path.join(base, "skills");
}

async function installSkillsForTarget(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  tool: "codex" | "claude",
): Promise<SkillsInstallSummary> {
  const summary: SkillsInstallSummary = {
    tool,
    target: targetSkillsDir,
    linked: [],
    removed: [],
    skipped: [],
    failed: [],
  };

  await fs.mkdir(targetSkillsDir, { recursive: true });
  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });
  summary.removed = await removeMaintainerOnlySkillSymlinks(
    targetSkillsDir,
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceSkillsDir, entry.name);
    const target = path.join(targetSkillsDir, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink()) {
        let linkedPath: string | null = null;
        try {
          linkedPath = await fs.readlink(target);
        } catch (err) {
          await fs.unlink(target);
          try {
            await fs.symlink(source, target);
            summary.linked.push(entry.name);
            continue;
          } catch (linkErr) {
            summary.failed.push({
              name: entry.name,
              error:
                err instanceof Error && linkErr instanceof Error
                  ? `${err.message}; then ${linkErr.message}`
                  : err instanceof Error
                    ? err.message
                    : `Failed to recover broken symlink: ${String(err)}`,
            });
            continue;
          }
        }

        const resolvedLinkedPath = path.isAbsolute(linkedPath)
          ? linkedPath
          : path.resolve(path.dirname(target), linkedPath);
        const linkedTargetExists = await fs
          .stat(resolvedLinkedPath)
          .then(() => true)
          .catch(() => false);

        if (!linkedTargetExists) {
          await fs.unlink(target);
        } else {
          summary.skipped.push(entry.name);
          continue;
        }
      } else {
        summary.skipped.push(entry.name);
        continue;
      }
    }

    try {
      await fs.symlink(source, target);
      summary.linked.push(entry.name);
    } catch (err) {
      summary.failed.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

function buildAgentEnvExports(input: {
  apiBase: string;
  companyId: string;
  agentId: string;
  apiKey: string;
}): string {
  const escaped = (value: string) => value.replace(/'/g, "'\"'\"'");
  return [
    `export PAPERCLIP_API_URL='${escaped(input.apiBase)}'`,
    `export PAPERCLIP_COMPANY_ID='${escaped(input.companyId)}'`,
    `export PAPERCLIP_AGENT_ID='${escaped(input.agentId)}'`,
    `export PAPERCLIP_API_KEY='${escaped(input.apiKey)}'`,
  ].join("\n");
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent operations");

  addCommonClientOptions(
    agent
      .command("list")
      .description("List agents for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Agent[]>(`/api/companies/${ctx.companyId}/agents`)) ?? [];

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
                role: row.role,
                status: row.status,
                reportsTo: row.reportsTo,
                budgetMonthlyCents: row.budgetMonthlyCents,
                spentMonthlyCents: row.spentMonthlyCents,
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
    agent
      .command("get")
      .description("Get one agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Agent>(`/api/agents/${agentId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("local-cli")
      .description(
        "Create an agent API key, install local Paperclip skills for Codex/Claude, and print shell exports",
      )
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--key-name <name>", "API key label", "local-cli")
      .option(
        "--no-install-skills",
        "Skip installing Paperclip skills into ~/.codex/skills and ~/.claude/skills",
      )
      .action(async (agentRef: string, opts: AgentLocalCliOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = new URLSearchParams({ companyId: ctx.companyId ?? "" });
          const agentRow = await ctx.api.get<Agent>(
            `/api/agents/${encodeURIComponent(agentRef)}?${query.toString()}`,
          );
          if (!agentRow) {
            throw new Error(`Agent not found: ${agentRef}`);
          }

          const now = new Date().toISOString().replaceAll(":", "-");
          const keyName = opts.keyName?.trim() ? opts.keyName.trim() : `local-cli-${now}`;
          const key = await ctx.api.post<CreatedAgentKey>(`/api/agents/${agentRow.id}/keys`, { name: keyName });
          if (!key) {
            throw new Error("Failed to create API key");
          }

          const installSummaries: SkillsInstallSummary[] = [];
          if (opts.installSkills !== false) {
            const skillsDir = await resolvePaperclipSkillsDir(__moduleDir, [path.resolve(process.cwd(), "skills")]);
            if (!skillsDir) {
              throw new Error(
                "Could not locate local Paperclip skills directory. Expected ./skills in the repo checkout.",
              );
            }

            installSummaries.push(
              await installSkillsForTarget(skillsDir, codexSkillsHome(), "codex"),
              await installSkillsForTarget(skillsDir, claudeSkillsHome(), "claude"),
            );
          }

          const exportsText = buildAgentEnvExports({
            apiBase: ctx.api.apiBase,
            companyId: agentRow.companyId,
            agentId: agentRow.id,
            apiKey: key.token,
          });

          if (ctx.json) {
            printOutput(
              {
                agent: {
                  id: agentRow.id,
                  name: agentRow.name,
                  urlKey: agentRow.urlKey,
                  companyId: agentRow.companyId,
                },
                key: {
                  id: key.id,
                  name: key.name,
                  createdAt: key.createdAt,
                  token: key.token,
                },
                skills: installSummaries,
                exports: exportsText,
              },
              { json: true },
            );
            return;
          }

          console.log(`Agent: ${agentRow.name} (${agentRow.id})`);
          console.log(`API key created: ${key.name} (${key.id})`);
          if (installSummaries.length > 0) {
            for (const summary of installSummaries) {
              console.log(
                `${summary.tool}: linked=${summary.linked.length} removed=${summary.removed.length} skipped=${summary.skipped.length} failed=${summary.failed.length} target=${summary.target}`,
              );
              for (const failed of summary.failed) {
                console.log(`  failed ${failed.name}: ${failed.error}`);
              }
            }
          }
          console.log("");
          console.log("# Run this in your shell before launching codex/claude:");
          console.log(exportsText);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("create")
      .description("Create a new agent")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Agent name")
      .option("--role <role>", "Agent role")
      .option("--title <title>", "Agent title")
      .option("--adapter-type <type>", "Adapter type")
      .option("--reports-to <agentId>", "ID of agent this agent reports to")
      .option("--adapter-config <json>", "Adapter config as JSON string or @filepath")
      .option("--runtime-config <json>", "Runtime config as JSON string or @filepath")
      .option("--budget <cents>", "Monthly budget in cents")
      .option("--capabilities <capabilities>", "Agent capabilities")
      .action(async (opts: AgentCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });

          const body: Record<string, unknown> = { name: opts.name };
          if (opts.role !== undefined) body.role = opts.role;
          if (opts.title !== undefined) body.title = opts.title;
          if (opts.adapterType !== undefined) body.adapterType = opts.adapterType;
          if (opts.reportsTo !== undefined) body.reportsTo = opts.reportsTo;
          if (opts.capabilities !== undefined) body.capabilities = opts.capabilities;
          if (opts.budget !== undefined) {
            const parsed = Number(opts.budget);
            if (!Number.isFinite(parsed) || parsed < 0) {
              throw new Error(`Invalid budget value '${opts.budget}': must be a non-negative integer (cents).`);
            }
            body.budgetMonthlyCents = parsed;
          }
          if (opts.adapterConfig !== undefined) body.adapterConfig = await parseJsonOption(opts.adapterConfig);
          if (opts.runtimeConfig !== undefined) body.runtimeConfig = await parseJsonOption(opts.runtimeConfig);

          const created = await ctx.api.post<Agent>(`/api/companies/${ctx.companyId}/agents`, body);
          if (!created) {
            throw new Error("Failed to create agent: server returned no data.");
          }

          if (ctx.json) {
            printOutput(created, { json: true });
            return;
          }

          console.log(
            formatInlineRecord({
              id: created.id,
              name: created.name,
              role: created.role,
              status: created.status,
            }),
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("update")
      .description("Update an existing agent")
      .argument("<agentId>", "Agent ID")
      .option("--name <name>", "Agent name")
      .option("--role <role>", "Agent role")
      .option("--status <status>", "Agent status")
      .option("--title <title>", "Agent title")
      .option("--adapter-type <type>", "Adapter type")
      .option("--reports-to <agentId>", "ID of agent this agent reports to")
      .option("--adapter-config <json>", "Adapter config as JSON string or @filepath")
      .option("--runtime-config <json>", "Runtime config as JSON string or @filepath")
      .option("--budget <cents>", "Monthly budget in cents")
      .option("--capabilities <capabilities>", "Agent capabilities")
      .action(async (agentId: string, opts: AgentUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          const body: Record<string, unknown> = {};
          if (opts.name !== undefined) body.name = opts.name;
          if (opts.role !== undefined) body.role = opts.role;
          if (opts.status !== undefined) body.status = opts.status;
          if (opts.title !== undefined) body.title = opts.title;
          if (opts.adapterType !== undefined) body.adapterType = opts.adapterType;
          if (opts.reportsTo !== undefined) body.reportsTo = opts.reportsTo;
          if (opts.capabilities !== undefined) body.capabilities = opts.capabilities;
          if (opts.budget !== undefined) {
            const parsed = Number(opts.budget);
            if (!Number.isFinite(parsed) || parsed < 0) {
              throw new Error(`Invalid budget value '${opts.budget}': must be a non-negative integer (cents).`);
            }
            body.budgetMonthlyCents = parsed;
          }
          if (opts.adapterConfig !== undefined) body.adapterConfig = await parseJsonOption(opts.adapterConfig);
          if (opts.runtimeConfig !== undefined) body.runtimeConfig = await parseJsonOption(opts.runtimeConfig);

          const updated = await ctx.api.patch<Agent>(`/api/agents/${agentId}`, body);
          if (!updated) {
            throw new Error("Failed to update agent: server returned no data.");
          }

          if (ctx.json) {
            printOutput(updated, { json: true });
            return;
          }

          console.log(
            formatInlineRecord({
              id: updated.id,
              name: updated.name,
              role: updated.role,
              status: updated.status,
            }),
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("delete")
      .description("Delete an agent (destructive)")
      .argument("<agentId>", "Agent ID")
      .option("--yes", "Required safety flag to confirm destructive action", false)
      .option("--confirm <value>", "Required safety value: must match agent ID")
      .action(async (agentId: string, opts: AgentDeleteOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          if (!opts.yes) {
            throw new Error("Deletion requires --yes.");
          }

          const confirm = opts.confirm?.trim();
          if (!confirm) {
            throw new Error("Deletion requires --confirm <value> where value matches the agent ID.");
          }

          const existing = await ctx.api.get<Agent>(`/api/agents/${agentId}`);
          if (!existing) {
            throw new Error(`Agent not found: ${agentId}`);
          }

          if (confirm !== existing.id) {
            throw new Error(
              `Confirmation '${confirm}' does not match agent ID '${existing.id}'.`,
            );
          }

          await ctx.api.delete<{ ok: true }>(`/api/agents/${agentId}`);

          printOutput(
            { ok: true, deleted: { id: existing.id, name: existing.name } },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
