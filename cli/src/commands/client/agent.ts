import { Command } from "commander";
import type { Agent } from "@paperclipai/shared";
import { AGENT_ADAPTER_TYPES, AGENT_ROLES } from "@paperclipai/shared";
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
  adapterType: string;
  role?: string;
  title?: string;
  reportsTo?: string;
}

interface AgentUpdateOptions extends BaseClientOptions {
  name?: string;
  adapterType?: string;
  role?: string;
  title?: string;
  reportsTo?: string;
}

interface AgentDeleteOptions extends BaseClientOptions {
  force?: boolean;
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
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PAPERCLIP_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../../../../skills"), // dev: cli/src/commands/client -> repo root/skills
  path.resolve(process.cwd(), "skills"),
];

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

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of PAPERCLIP_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
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
    skipped: [],
    failed: [],
  };

  await fs.mkdir(targetSkillsDir, { recursive: true });
  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceSkillsDir, entry.name);
    const target = path.join(targetSkillsDir, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) {
      summary.skipped.push(entry.name);
      continue;
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
            const skillsDir = await resolvePaperclipSkillsDir();
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
                `${summary.tool}: linked=${summary.linked.length} skipped=${summary.skipped.length} failed=${summary.failed.length} target=${summary.target}`,
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
      .requiredOption("-n, --name <name>", "Agent name")
      .requiredOption(
        "-a, --adapter-type <type>",
        `Adapter type (${AGENT_ADAPTER_TYPES.join(", ")})`,
      )
      .option("-r, --role <role>", `Agent role (${AGENT_ROLES.join(", ")})`, "general")
      .option("-t, --title <title>", "Agent title")
      .option("--reports-to <agentId>", "Manager agent ID")
      .action(async (opts: AgentCreateOptions) => {
        try {
          if (!AGENT_ADAPTER_TYPES.includes(opts.adapterType)) {
            throw new Error(
              `Invalid adapter type "${opts.adapterType}". Must be one of: ${AGENT_ADAPTER_TYPES.join(", ")}`,
            );
          }
          if (opts.role && !AGENT_ROLES.includes(opts.role)) {
            throw new Error(
              `Invalid role "${opts.role}". Must be one of: ${AGENT_ROLES.join(", ")}`,
            );
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const body: Record<string, unknown> = {
            name: opts.name,
            adapterType: opts.adapterType,
            role: opts.role,
          };
          if (opts.title) body.title = opts.title;
          if (opts.reportsTo) body.reportsTo = opts.reportsTo;

          const row = await ctx.api.post<Agent>(
            `/api/companies/${ctx.companyId}/agents`,
            body,
          );

          if (ctx.json) {
            printOutput(row, { json: true });
            return;
          }

          if (row) {
            console.log(
              formatInlineRecord({
                id: row.id,
                name: row.name,
                role: row.role,
                status: row.status,
                adapterType: row.adapterType,
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
      .command("update")
      .description("Update an existing agent")
      .argument("<agentId>", "Agent ID")
      .option("-n, --name <name>", "Agent name")
      .option(
        "-a, --adapter-type <type>",
        `Adapter type (${AGENT_ADAPTER_TYPES.join(", ")})`,
      )
      .option("-r, --role <role>", `Agent role (${AGENT_ROLES.join(", ")})`)
      .option("-t, --title <title>", "Agent title")
      .option("--reports-to <agentId>", "Manager agent ID")
      .action(async (agentId: string, opts: AgentUpdateOptions) => {
        try {
          if (opts.adapterType && !AGENT_ADAPTER_TYPES.includes(opts.adapterType)) {
            throw new Error(
              `Invalid adapter type "${opts.adapterType}". Must be one of: ${AGENT_ADAPTER_TYPES.join(", ")}`,
            );
          }
          if (opts.role && !AGENT_ROLES.includes(opts.role)) {
            throw new Error(
              `Invalid role "${opts.role}". Must be one of: ${AGENT_ROLES.join(", ")}`,
            );
          }
          const ctx = resolveCommandContext(opts);
          const body: Record<string, unknown> = {};
          if (opts.name) body.name = opts.name;
          if (opts.adapterType) body.adapterType = opts.adapterType;
          if (opts.role) body.role = opts.role;
          if (opts.title) body.title = opts.title;
          if (opts.reportsTo) body.reportsTo = opts.reportsTo;

          if (Object.keys(body).length === 0) {
            throw new Error(
              "No update fields provided. Use --name, --role, --title, --adapter-type, or --reports-to.",
            );
          }

          const row = await ctx.api.patch<Agent>(`/api/agents/${agentId}`, body);

          if (ctx.json) {
            printOutput(row, { json: true });
            return;
          }

          if (row) {
            console.log(
              formatInlineRecord({
                id: row.id,
                name: row.name,
                role: row.role,
                status: row.status,
                adapterType: row.adapterType,
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("delete")
      .description("Terminate (permanently deactivate) an agent")
      .argument("<agentId>", "Agent ID")
      .option("-f, --force", "Skip confirmation")
      .action(async (agentId: string, opts: AgentDeleteOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          if (!opts.force) {
            const readline = await import("node:readline");
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });
            const answer = await new Promise<string>((resolve) => {
              rl.question(
                `Terminate agent ${agentId}? This is irreversible. (yes/no) `,
                resolve,
              );
            });
            rl.close();
            if (answer.trim().toLowerCase() !== "yes") {
              console.log("Aborted.");
              return;
            }
          }

          await ctx.api.post(`/api/agents/${agentId}/terminate`);

          if (ctx.json) {
            printOutput({ id: agentId, status: "terminated" }, { json: true });
            return;
          }

          console.log(`Agent ${agentId} terminated.`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
