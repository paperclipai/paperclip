import { Command } from "commander";
import {
  createAgentKeySchema,
  createAgentSchema,
  updateAgentPermissionsSchema,
  updateAgentSchema,
  wakeAgentSchema,
  type Agent,
} from "@paperclipai/shared";
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

interface AgentLocalCliOptions extends BaseClientOptions {
  companyId?: string;
  keyName?: string;
  installSkills?: boolean;
}

interface AgentCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  adapterType: string;
  role?: string;
  title?: string;
  icon?: string;
  reportsTo?: string;
  capabilities?: string;
  desiredSkills?: string;
  adapterConfig?: string;
  runtimeConfig?: string;
  defaultEnvironmentId?: string;
  budgetMonthlyCents?: string;
  metadata?: string;
}

interface AgentUpdateOptions extends BaseClientOptions {
  name?: string;
  role?: string;
  title?: string;
  icon?: string;
  reportsTo?: string;
  capabilities?: string;
  desiredSkills?: string;
  adapterType?: string;
  adapterConfig?: string;
  replaceAdapterConfig?: boolean;
  runtimeConfig?: string;
  defaultEnvironmentId?: string;
  budgetMonthlyCents?: string;
  status?: string;
  metadata?: string;
}

interface AgentDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface AgentPermissionsOptions extends BaseClientOptions {
  canCreateAgents: string;
  canAssignTasks: string;
}

interface AgentKeyCreateOptions extends BaseClientOptions {
  name?: string;
}

interface AgentKeyDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface AgentWakeupOptions extends BaseClientOptions {
  source?: string;
  triggerDetail?: string;
  reason?: string;
  payload?: string;
  idempotencyKey?: string;
  forceFreshSession?: boolean;
}

function parseJsonObject(
  raw: string | undefined,
  flag: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--${flag} must be valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseBoolFlag(value: string, name: string): boolean {
  const v = value.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`--${name} must be true or false`);
}

function parseIntOpt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return n;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

async function confirmAction(message: string): Promise<boolean> {
  const { confirm } = await import("@clack/prompts");
  const answer = await confirm({ message, initialValue: false });
  return answer === true;
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
      .description("Create a new agent in a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Agent display name")
      .requiredOption("--adapter-type <type>", "Adapter type (e.g. claude, codex, copilot)")
      .option("--role <role>", "Agent role")
      .option("--title <title>", "Agent title")
      .option("--icon <icon>", "Agent icon name")
      .option("--reports-to <id>", "Manager agent UUID")
      .option("--capabilities <text>", "Capabilities description")
      .option("--desired-skills <list>", "Comma-separated desired skill names")
      .option("--adapter-config <json>", "Adapter config as JSON object", "{}")
      .option("--runtime-config <json>", "Runtime config as JSON object", "{}")
      .option("--default-environment-id <id>", "Default environment UUID")
      .option("--budget-monthly-cents <n>", "Monthly budget in cents")
      .option("--metadata <json>", "Metadata as JSON object")
      .action(async (opts: AgentCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });

          const payload: Record<string, unknown> = {
            name: opts.name,
            adapterType: opts.adapterType,
          };
          if (opts.role !== undefined) payload.role = opts.role;
          if (opts.title !== undefined) payload.title = opts.title;
          if (opts.icon !== undefined) payload.icon = opts.icon;
          if (opts.reportsTo !== undefined) payload.reportsTo = opts.reportsTo;
          if (opts.capabilities !== undefined) payload.capabilities = opts.capabilities;
          const skills = splitCsv(opts.desiredSkills);
          if (skills !== undefined) payload.desiredSkills = skills;
          const adapterConfig = parseJsonObject(opts.adapterConfig, "adapter-config");
          if (adapterConfig !== undefined) payload.adapterConfig = adapterConfig;
          const runtimeConfig = parseJsonObject(opts.runtimeConfig, "runtime-config");
          if (runtimeConfig !== undefined) payload.runtimeConfig = runtimeConfig;
          if (opts.defaultEnvironmentId !== undefined)
            payload.defaultEnvironmentId = opts.defaultEnvironmentId;
          const budget = parseIntOpt(opts.budgetMonthlyCents, "budget-monthly-cents");
          if (budget !== undefined) payload.budgetMonthlyCents = budget;
          const metadata = parseJsonObject(opts.metadata, "metadata");
          if (metadata !== undefined) payload.metadata = metadata;

          const parsed = createAgentSchema.parse(payload);
          const row = await ctx.api.post<Agent>(
            `/api/companies/${ctx.companyId}/agents`,
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
    agent
      .command("update")
      .description("Update an agent's mutable fields")
      .argument("<agentId>", "Agent ID")
      .option("--name <name>", "New name")
      .option("--role <role>", "New role")
      .option("--title <title>", "New title")
      .option("--icon <icon>", "New icon")
      .option("--reports-to <id>", "New manager agent UUID (or empty string to unset)")
      .option("--capabilities <text>", "New capabilities description")
      .option("--desired-skills <list>", "Comma-separated desired skills (replaces list)")
      .option("--adapter-type <type>", "New adapter type")
      .option("--adapter-config <json>", "Adapter config as JSON object (merged unless --replace-adapter-config)")
      .option("--replace-adapter-config", "Replace adapter config wholesale instead of merging")
      .option("--runtime-config <json>", "Runtime config as JSON object")
      .option("--default-environment-id <id>", "New default environment UUID")
      .option("--budget-monthly-cents <n>", "New monthly budget in cents")
      .option("--status <status>", "New status")
      .option("--metadata <json>", "Metadata as JSON object")
      .action(async (agentId: string, opts: AgentUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.name !== undefined) payload.name = opts.name;
          if (opts.role !== undefined) payload.role = opts.role;
          if (opts.title !== undefined) payload.title = opts.title;
          if (opts.icon !== undefined) payload.icon = opts.icon;
          if (opts.reportsTo !== undefined) payload.reportsTo = opts.reportsTo === "" ? null : opts.reportsTo;
          if (opts.capabilities !== undefined) payload.capabilities = opts.capabilities;
          const skills = splitCsv(opts.desiredSkills);
          if (skills !== undefined) payload.desiredSkills = skills;
          if (opts.adapterType !== undefined) payload.adapterType = opts.adapterType;
          const adapterConfig = parseJsonObject(opts.adapterConfig, "adapter-config");
          if (adapterConfig !== undefined) payload.adapterConfig = adapterConfig;
          if (opts.replaceAdapterConfig) payload.replaceAdapterConfig = true;
          const runtimeConfig = parseJsonObject(opts.runtimeConfig, "runtime-config");
          if (runtimeConfig !== undefined) payload.runtimeConfig = runtimeConfig;
          if (opts.defaultEnvironmentId !== undefined)
            payload.defaultEnvironmentId = opts.defaultEnvironmentId === ""
              ? null
              : opts.defaultEnvironmentId;
          const budget = parseIntOpt(opts.budgetMonthlyCents, "budget-monthly-cents");
          if (budget !== undefined) payload.budgetMonthlyCents = budget;
          if (opts.status !== undefined) payload.status = opts.status;
          const metadata = parseJsonObject(opts.metadata, "metadata");
          if (metadata !== undefined) payload.metadata = metadata;

          const parsed = updateAgentSchema.parse(payload);
          const row = await ctx.api.patch<Agent>(
            `/api/agents/${encodeURIComponent(agentId)}`,
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
    agent
      .command("delete")
      .description("Delete an agent")
      .argument("<agentId>", "Agent ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (agentId: string, opts: AgentDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(`Delete agent ${agentId}? This cannot be undone.`);
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<Agent>(`/api/agents/${encodeURIComponent(agentId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  for (const action of ["pause", "resume", "approve", "terminate"] as const) {
    addCommonClientOptions(
      agent
        .command(action)
        .description(`${action[0].toUpperCase()}${action.slice(1)} an agent`)
        .argument("<agentId>", "Agent ID")
        .action(async (agentId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.post<Agent>(
              `/api/agents/${encodeURIComponent(agentId)}/${action}`,
              {},
            );
            printOutput(row, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );
  }

  addCommonClientOptions(
    agent
      .command("permissions")
      .description("Update agent permissions (canCreateAgents, canAssignTasks)")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--can-create-agents <bool>", "true or false")
      .requiredOption("--can-assign-tasks <bool>", "true or false")
      .action(async (agentId: string, opts: AgentPermissionsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const parsed = updateAgentPermissionsSchema.parse({
            canCreateAgents: parseBoolFlag(opts.canCreateAgents, "can-create-agents"),
            canAssignTasks: parseBoolFlag(opts.canAssignTasks, "can-assign-tasks"),
          });
          const row = await ctx.api.patch<Agent>(
            `/api/agents/${encodeURIComponent(agentId)}/permissions`,
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
    agent
      .command("wakeup")
      .description("Wake up an agent (enqueue a heartbeat run)")
      .argument("<agentId>", "Agent ID")
      .option("--source <source>", "Source (timer, assignment, on_demand, automation)")
      .option("--trigger-detail <detail>", "Trigger detail (manual, ping, callback, system)")
      .option("--reason <text>", "Reason")
      .option("--payload <json>", "Wake-up payload as JSON object")
      .option("--idempotency-key <key>", "Idempotency key")
      .option("--force-fresh-session", "Force a fresh session")
      .action(async (agentId: string, opts: AgentWakeupOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.source !== undefined) payload.source = opts.source;
          if (opts.triggerDetail !== undefined) payload.triggerDetail = opts.triggerDetail;
          if (opts.reason !== undefined) payload.reason = opts.reason;
          const wakePayload = parseJsonObject(opts.payload, "payload");
          if (wakePayload !== undefined) payload.payload = wakePayload;
          if (opts.idempotencyKey !== undefined) payload.idempotencyKey = opts.idempotencyKey;
          if (opts.forceFreshSession) payload.forceFreshSession = true;

          const parsed = wakeAgentSchema.parse(payload);
          const row = await ctx.api.post<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/wakeup`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const key = agent.command("key").description("Agent API key operations");

  addCommonClientOptions(
    key
      .command("list")
      .description("List API keys for an agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/agents/${encodeURIComponent(agentId)}/keys`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    key
      .command("create")
      .description("Create a new API key for an agent (token returned once)")
      .argument("<agentId>", "Agent ID")
      .option("--name <name>", "Key label", "default")
      .action(async (agentId: string, opts: AgentKeyCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createAgentKeySchema.parse({ name: opts.name ?? "default" });
          const row = await ctx.api.post<CreatedAgentKey>(
            `/api/agents/${encodeURIComponent(agentId)}/keys`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    key
      .command("delete")
      .description("Delete an API key")
      .argument("<agentId>", "Agent ID")
      .argument("<keyId>", "Key ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (agentId: string, keyId: string, opts: AgentKeyDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(
              `Delete API key ${keyId} for agent ${agentId}? Anything using it will lose access.`,
            );
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/keys/${encodeURIComponent(keyId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
