import { Command } from "commander";
import {
  agentSkillSyncSchema,
  createAgentSchema,
  resetAgentSessionSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentInstructionsPathSchema,
  updateAgentPermissionsSchema,
  updateAgentSchema,
  upsertAgentInstructionsFileSchema,
  wakeAgentSchema,
  type Agent,
  type AgentWakeupResponse,
  type Issue,
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
  apiPath,
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

interface AgentInboxMineOptions extends BaseClientOptions {
  userId: string;
  status?: string;
}

interface AgentWakeOptions extends BaseClientOptions {
  companyId?: string;
  source?: string;
  trigger?: string;
  reason?: string;
  payload?: string;
  idempotencyKey?: string;
  forceFreshSession?: boolean;
}

interface AgentJsonPayloadOptions extends BaseClientOptions {
  companyId?: string;
  payloadJson: string;
}

interface AgentDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface AgentResetSessionOptions extends BaseClientOptions {
  taskKey?: string;
}

interface AgentSkillsSyncOptions extends BaseClientOptions {
  desiredSkills: string;
}

interface AgentInstructionsFileOptions extends BaseClientOptions {
  path: string;
}

interface AgentInstructionsFilePutOptions extends BaseClientOptions {
  path: string;
  content?: string;
  contentFile?: string;
  clearLegacyPromptTemplate?: boolean;
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
      .command("me")
      .description("Show the current agent identity")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const me = await ctx.api.get<Agent>("/api/agents/me");
          printOutput(me, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("inbox")
      .description("List current agent assigned inbox items")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<Issue[]>("/api/agents/me/inbox-lite")) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              identifier: row.identifier,
              id: row.id,
              status: row.status,
              priority: row.priority,
              title: row.title,
              projectId: row.projectId,
            }));
          }
          if (rows.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("inbox-mine")
      .description("List current agent inbox items touched or archived by a board user")
      .requiredOption("--user-id <id>", "Board user ID")
      .option("--status <csv>", "Comma-separated issue statuses")
      .action(async (opts: AgentInboxMineOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams({ userId: opts.userId });
          if (opts.status) params.set("status", opts.status);
          const rows = (await ctx.api.get<Issue[]>(`/api/agents/me/inbox/mine?${params.toString()}`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("list")
      .description("List agents for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: AgentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Agent[]>(apiPath`/api/companies/${ctx.companyId}/agents`)) ?? [];

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
          const row = await ctx.api.get<Agent>(apiPath`/api/agents/${agentId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("create")
      .description("Create an agent from a JSON payload")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "CreateAgent JSON payload")
      .action(async (opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createAgentSchema.parse(parseJson(opts.payloadJson));
          const created = await ctx.api.post<Agent>(apiPath`/api/companies/${ctx.companyId}/agents`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("hire")
      .description("Create an agent hire request")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "CreateAgentHire JSON payload")
      .action(async (opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/agent-hires`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("update")
      .description("Update an agent from a JSON payload")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateAgent JSON payload")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentSchema.parse(parseJson(opts.payloadJson));
          const updated = await ctx.api.patch<Agent>(apiPath`/api/agents/${agentId}`, payload);
          printOutput(updated, { json: ctx.json });
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
      .option("--yes", "Confirm deletion")
      .action(async (agentId: string, opts: AgentDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("Refusing to delete without --yes");
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/agents/${agentId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, path, description] of [
    ["pause", "pause", "Pause an agent"],
    ["resume", "resume", "Resume an agent"],
    ["approve", "approve", "Approve a pending agent"],
    ["terminate", "terminate", "Terminate an agent"],
    ["heartbeat:invoke", "heartbeat/invoke", "Invoke an agent heartbeat"],
    ["claude-login", "claude-login", "Trigger Claude login for an agent"],
  ] as const) {
    addCommonClientOptions(
      agent
        .command(name)
        .description(description)
        .argument("<agentId>", "Agent ID")
        .action(async (agentId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const result = await ctx.api.post(`${apiPath`/api/agents/${agentId}`}/${path}`, {});
            printOutput(result, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    agent
      .command("permissions:update")
      .description("Update agent permissions")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateAgentPermissions JSON payload")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentPermissionsSchema.parse(parseJson(opts.payloadJson));
          const updated = await ctx.api.patch(apiPath`/api/agents/${agentId}/permissions`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("configuration")
      .description("Get redacted agent configuration")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/configuration`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revisions")
      .description("List agent config revisions")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/config-revisions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revision:get")
      .description("Get one agent config revision")
      .argument("<agentId>", "Agent ID")
      .argument("<revisionId>", "Revision ID")
      .action(async (agentId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/config-revisions/${revisionId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("config-revision:rollback")
      .description("Roll an agent back to a config revision")
      .argument("<agentId>", "Agent ID")
      .argument("<revisionId>", "Revision ID")
      .action(async (agentId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/config-revisions/${revisionId}/rollback`, {});
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("runtime-state")
      .description("Get agent runtime state")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/runtime-state`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("runtime-state:reset-session")
      .description("Reset an agent runtime session")
      .argument("<agentId>", "Agent ID")
      .option("--task-key <key>", "Specific task session key")
      .action(async (agentId: string, opts: AgentResetSessionOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resetAgentSessionSchema.parse({ taskKey: opts.taskKey });
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/runtime-state/reset-session`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("task-sessions")
      .description("List agent task sessions")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/task-sessions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("skills")
      .description("List agent skills")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/skills`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("skills:sync")
      .description("Sync desired skills onto an agent")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--desired-skills <csv>", "Desired skill names")
      .action(async (agentId: string, opts: AgentSkillsSyncOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = agentSkillSyncSchema.parse({ desiredSkills: parseCsv(opts.desiredSkills) });
          const result = await ctx.api.post(apiPath`/api/agents/${agentId}/skills/sync`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-path:update")
      .description("Update an agent instructions path. Process adapters require adapterConfigKey and relative paths require adapterConfig.cwd.")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateAgentInstructionsPath JSON payload, for example {\"path\":\"/tmp/AGENTS.md\",\"adapterConfigKey\":\"instructionsFilePath\"}")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentInstructionsPathSchema.parse(parseJson(opts.payloadJson));
          const result = await ctx.api.patch(apiPath`/api/agents/${agentId}/instructions-path`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-bundle")
      .description("Get an agent instructions bundle")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/agents/${agentId}/instructions-bundle`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-bundle:update")
      .description("Update an agent instructions bundle")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateAgentInstructionsBundle JSON payload")
      .action(async (agentId: string, opts: AgentJsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateAgentInstructionsBundleSchema.parse(parseJson(opts.payloadJson));
          const result = await ctx.api.patch(apiPath`/api/agents/${agentId}/instructions-bundle`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:get")
      .description("Get an agent instructions file")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <path>", "Bundle-relative file path")
      .action(async (agentId: string, opts: AgentInstructionsFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams({ path: opts.path });
          const result = await ctx.api.get(`${apiPath`/api/agents/${agentId}/instructions-bundle/file`}?${query.toString()}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:put")
      .description("Create or update an agent instructions file")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <path>", "Bundle-relative file path")
      .option("--content <text>", "File content")
      .option("--content-file <path>", "Read file content from disk")
      .option("--clear-legacy-prompt-template", "Clear legacy prompt template")
      .action(async (agentId: string, opts: AgentInstructionsFilePutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const content = opts.contentFile ? await fs.readFile(opts.contentFile, "utf8") : opts.content;
          const payload = upsertAgentInstructionsFileSchema.parse({
            path: opts.path,
            content,
            clearLegacyPromptTemplate: Boolean(opts.clearLegacyPromptTemplate),
          });
          const result = await ctx.api.put(apiPath`/api/agents/${agentId}/instructions-bundle/file`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("instructions-file:delete")
      .description("Delete an agent instructions file")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <path>", "Bundle-relative file path")
      .action(async (agentId: string, opts: AgentInstructionsFileOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams({ path: opts.path });
          const result = await ctx.api.delete(`${apiPath`/api/agents/${agentId}/instructions-bundle/file`}?${query.toString()}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    agent
      .command("wake")
      .description("Request a heartbeat wakeup for an agent")
      .argument("<agentRef>", "Agent ID or shortname/url-key")
      .option("-C, --company-id <id>", "Company ID for shortname/url-key lookup")
      .option("--source <source>", "Invocation source (assignment, on_demand, automation)", "on_demand")
      .option("--trigger <trigger>", "Trigger detail (manual, ping, callback, system)", "manual")
      .option("--reason <text>", "Wakeup reason")
      .option("--payload <json>", "JSON object payload")
      .option("--idempotency-key <key>", "Wakeup idempotency key")
      .option("--force-fresh-session", "Request a fresh adapter session")
      .action(async (agentRef: string, opts: AgentWakeOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.companyId ? `?${new URLSearchParams({ companyId: opts.companyId }).toString()}` : "";
          const agentRow = await ctx.api.get<Agent>(`${apiPath`/api/agents/${agentRef}`}${query}`);
          if (!agentRow) {
            throw new Error(`Agent not found: ${agentRef}`);
          }
          const payload = wakeAgentSchema.parse({
            source: opts.source,
            triggerDetail: opts.trigger,
            reason: opts.reason,
            payload: parseJsonObject(opts.payload),
            idempotencyKey: opts.idempotencyKey,
            forceFreshSession: Boolean(opts.forceFreshSession),
          });
          const result = await ctx.api.post<AgentWakeupResponse>(apiPath`/api/agents/${agentRow.id}/wakeup`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
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
            `${apiPath`/api/agents/${agentRef}`}?${query.toString()}`,
          );
          if (!agentRow) {
            throw new Error(`Agent not found: ${agentRef}`);
          }

          const now = new Date().toISOString().replaceAll(":", "-");
          const keyName = opts.keyName?.trim() ? opts.keyName.trim() : `local-cli-${now}`;
          const key = await ctx.api.post<CreatedAgentKey>(apiPath`/api/agents/${agentRow.id}/keys`, { name: keyName });
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
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}
