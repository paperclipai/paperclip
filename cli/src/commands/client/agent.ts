import { Command } from "commander";
import type { Agent } from "@paperclipai/shared";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
  name?: string;
  role?: string;
  title?: string;
  reportsTo?: string;
  adapterType?: string;
  adapterConfig?: string;
  runtimeConfig?: string;
  budget?: string;
}

interface AgentUpdateOptions extends BaseClientOptions {
  name?: string;
  role?: string;
  status?: string;
  adapterType?: string;
  adapterConfig?: string;
  runtimeConfig?: string;
  budget?: string;
  title?: string;
  reportsTo?: string;
}

interface AgentDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

function parseJsonOrFile(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  
  // Check if it's a file path (@path/to/file.json)
  if (input.startsWith("@")) {
    const filePath = input.slice(1);
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }
    const content = fs.readFileSync(resolvedPath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
  }
  
  // Parse as inline JSON
  return JSON.parse(input) as Record<string, unknown>;
}

function parseBudgetCents(budget: string | undefined): number | undefined {
  if (!budget) return undefined;
  const cents = Math.round(parseFloat(budget) * 100);
  if (isNaN(cents) || cents < 0) {
    throw new Error("Budget must be a positive number (in dollars)");
  }
  return cents;
}

async function confirmDelete(agentName: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve) => {
    rl.question(`Are you sure you want to delete agent "${agentName}"? This action cannot be undone. [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
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
      .command("create")
      .description("Create a new agent")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Agent name")
      .requiredOption("--adapter-type <type>", "Adapter type (process, http, claude_local, codex_local, opencode_local, pi_local, cursor, openclaw_gateway)")
      .option("--role <role>", "Agent role (ceo, cto, cmo, cfo, engineer, designer, pm, qa, devops, researcher, general)", "general")
      .option("--title <title>", "Agent title")
      .option("--reports-to <agentId>", "ID of agent this agent reports to")
      .option("--adapter-config <json>", "Adapter config as JSON string or @path/to/file.json")
      .option("--runtime-config <json>", "Runtime config as JSON string")
      .option("--budget <dollars>", "Monthly budget in dollars (e.g., 100.00)")
      .action(async (opts: AgentCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          
          const body: Record<string, unknown> = {
            name: opts.name,
            adapterType: opts.adapterType,
            role: opts.role ?? "general",
          };

          if (opts.title) body.title = opts.title;
          if (opts.reportsTo) body.reportsTo = opts.reportsTo;
          if (opts.budget) body.budgetMonthlyCents = parseBudgetCents(opts.budget);
          
          if (opts.adapterConfig) {
            body.adapterConfig = parseJsonOrFile(opts.adapterConfig);
          }
          
          if (opts.runtimeConfig) {
            body.runtimeConfig = parseJsonOrFile(opts.runtimeConfig);
          }

          const created = await ctx.api.post<Agent>(`/api/companies/${ctx.companyId}/agents`, body);
          
          if (!created) {
            throw new Error("Failed to create agent");
          }
          
          if (ctx.json) {
            printOutput(created, { json: true });
          } else {
            console.log("Agent created successfully:");
            console.log(formatInlineRecord({
              id: created.id,
              name: created.name,
              role: created.role,
              status: created.status,
              adapterType: created.adapterType,
            }));
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
      .description("Update an agent")
      .argument("<agentId>", "Agent ID")
      .option("--name <name>", "Agent name")
      .option("--role <role>", "Agent role")
      .option("--status <status>", "Agent status")
      .option("--title <title>", "Agent title")
      .option("--reports-to <agentId>", "ID of agent this agent reports to")
      .option("--adapter-type <type>", "Adapter type")
      .option("--adapter-config <json>", "Adapter config as JSON string or @path/to/file.json")
      .option("--runtime-config <json>", "Runtime config as JSON string")
      .option("--budget <dollars>", "Monthly budget in dollars (e.g., 100.00)")
      .action(async (agentId: string, opts: AgentUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          
          const body: Record<string, unknown> = {};

          if (opts.name !== undefined) body.name = opts.name;
          if (opts.role !== undefined) body.role = opts.role;
          if (opts.status !== undefined) body.status = opts.status;
          if (opts.title !== undefined) body.title = opts.title;
          if (opts.reportsTo !== undefined) body.reportsTo = opts.reportsTo;
          if (opts.adapterType !== undefined) body.adapterType = opts.adapterType;
          if (opts.budget !== undefined) body.budgetMonthlyCents = parseBudgetCents(opts.budget);
          
          if (opts.adapterConfig !== undefined) {
            body.adapterConfig = parseJsonOrFile(opts.adapterConfig);
          }
          
          if (opts.runtimeConfig !== undefined) {
            body.runtimeConfig = parseJsonOrFile(opts.runtimeConfig);
          }

          if (Object.keys(body).length === 0) {
            console.error("Error: No fields to update. Provide at least one option.");
            process.exit(1);
          }

          const updated = await ctx.api.patch<Agent>(`/api/agents/${agentId}`, body);
          
          if (!updated) {
            throw new Error("Failed to update agent");
          }
          
          if (ctx.json) {
            printOutput(updated, { json: true });
          } else {
            console.log("Agent updated successfully:");
            console.log(formatInlineRecord({
              id: updated.id,
              name: updated.name,
              role: updated.role,
              status: updated.status,
              adapterType: updated.adapterType,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("delete")
      .description("Delete an agent")
      .argument("<agentId>", "Agent ID")
      .option("--yes", "Skip confirmation prompt")
      .action(async (agentId: string, opts: AgentDeleteOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          
          // First get the agent to show its name in the confirmation
          const agent = await ctx.api.get<Agent>(`/api/agents/${agentId}`);
          
          if (!agent) {
            throw new Error(`Agent not found: ${agentId}`);
          }
          
          if (!opts.yes) {
            const confirmed = await confirmDelete(agent.name);
            if (!confirmed) {
              console.log("Deletion cancelled.");
              return;
            }
          }

          await ctx.api.delete(`/api/agents/${agentId}`);
          
          if (ctx.json) {
            printOutput({ ok: true, deleted: { id: agent.id, name: agent.name } }, { json: true });
          } else {
            console.log(`Agent "${agent.name}" (${agent.id}) deleted successfully.`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
