import { Command } from "commander";
import type { Agent } from "@paperclipai/shared";
import {
  isClaudeCliAdapterType,
  isCodebuddyCliAdapterType,
  isCodexCliAdapterType,
  isCursorCliAdapterType,
  isQwenCliAdapterType,
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

interface CreatedAgentKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

interface SkillsInstallSummary {
  tool: "codex" | "claude" | "cursor" | "codebuddy" | "qwen";
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

function cursorSkillsHome(): string {
  return path.join(os.homedir(), ".cursor", "skills");
}

function codebuddySkillsHome(): string {
  return path.join(os.homedir(), ".codebuddy", "skills");
}

function qwenSkillsHome(): string {
  return path.join(os.homedir(), ".qwen", "skills");
}

async function installSkillsForTarget(
  sourceSkillsDir: string,
  targetSkillsDir: string,
  tool: "codex" | "claude" | "cursor" | "codebuddy" | "qwen",
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
        "Create an agent API key, install local Paperclip skills for the agent's CLI adapter, and print shell exports",
      )
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--key-name <name>", "API key label", "local-cli")
      .option(
        "--no-install-skills",
        "Skip installing Paperclip skills into the CLI home for this agent's adapter (e.g. ~/.codex/skills, ~/.claude/skills, ~/.cursor/skills)",
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
          let skillsSkipReason: string | null = null;
          if (opts.installSkills !== false) {
            const skillsDir = await resolvePaperclipSkillsDir(__moduleDir, [path.resolve(process.cwd(), "skills")]);
            if (!skillsDir) {
              throw new Error(
                "Could not locate local Paperclip skills directory. Expected ./skills in the repo checkout.",
              );
            }

            const t = agentRow.adapterType ?? "";
            const targets: Array<{ tool: SkillsInstallSummary["tool"]; dir: string }> = [];
            if (isCodexCliAdapterType(t)) targets.push({ tool: "codex", dir: codexSkillsHome() });
            if (isClaudeCliAdapterType(t)) targets.push({ tool: "claude", dir: claudeSkillsHome() });
            if (isCursorCliAdapterType(t)) targets.push({ tool: "cursor", dir: cursorSkillsHome() });
            if (isCodebuddyCliAdapterType(t)) targets.push({ tool: "codebuddy", dir: codebuddySkillsHome() });
            if (isQwenCliAdapterType(t)) targets.push({ tool: "qwen", dir: qwenSkillsHome() });

            if (targets.length === 0) {
              skillsSkipReason =
                `Adapter type "${t}" has no mapped CLI skills home here (codex/claude/cursor/codebuddy_local/qwen_local).`;
              if (!ctx.json) {
                console.warn(`Skipping skill install: ${skillsSkipReason}`);
              }
            } else {
              for (const { tool, dir } of targets) {
                installSummaries.push(await installSkillsForTarget(skillsDir, dir, tool));
              }
            }
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
                skillsSkipReason,
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
          console.log("# Run this in your shell before launching your CLI agent:");
          console.log(exportsText);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
