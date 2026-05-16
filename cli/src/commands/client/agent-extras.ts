import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  agentMineInboxQuerySchema,
  agentSkillSyncSchema,
  createAgentHireSchema,
  resetAgentSessionSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentInstructionsPathSchema,
  upsertAgentInstructionsFileSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOnly extends BaseClientOptions {
  companyId?: string;
}

interface MineInboxOptions extends CompanyOnly {
  userId: string;
  status?: string;
}

interface PayloadOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface SkillsSetOptions extends BaseClientOptions {
  desiredSkills: string;
}

interface InstructionsPathOptions extends BaseClientOptions {
  path?: string;
  unset?: boolean;
  adapterConfigKey?: string;
}

interface InstructionsBundleUpdateOptions extends BaseClientOptions {
  mode?: string;
  rootPath?: string;
  unsetRootPath?: boolean;
  entryFile?: string;
  clearLegacyPromptTemplate?: boolean;
}

interface InstructionsFileGetOptions extends BaseClientOptions {
  path: string;
}

interface InstructionsFileUpsertOptions extends BaseClientOptions {
  path: string;
  content?: string;
  contentFile?: string;
  clearLegacyPromptTemplate?: boolean;
}

interface InstructionsFileDeleteOptions extends BaseClientOptions {
  path: string;
  yes?: boolean;
}

interface RunResetSessionOptions extends BaseClientOptions {
  taskKey?: string;
}

function readJson(opts: PayloadOptions, name: string): unknown {
  if (opts.payload !== undefined && opts.payloadFile !== undefined) {
    throw new Error(`Pass either --${name} or --${name}-file, not both.`);
  }
  if (opts.payload !== undefined) {
    try {
      return JSON.parse(opts.payload);
    } catch (err) {
      throw new Error(`--${name} must be valid JSON: ${(err as Error).message}`);
    }
  }
  if (opts.payloadFile !== undefined) {
    const raw = readFileSync(opts.payloadFile, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`--${name}-file must be valid JSON: ${(err as Error).message}`);
    }
  }
  return undefined;
}

async function confirmAction(message: string): Promise<boolean> {
  const { confirm } = await import("@clack/prompts");
  const answer = await confirm({ message, initialValue: false });
  return answer === true;
}

function getAgentCommand(program: Command): Command {
  const agent = program.commands.find((c) => c.name() === "agent");
  if (!agent) throw new Error("agent command not registered yet; load order error");
  return agent;
}

export function registerAgentExtensionCommands(program: Command): void {
  const agent = getAgentCommand(program);

  // ── self ────────────────────────────────────────────────────────────────
  addCommonClientOptions(
    agent
      .command("me")
      .description("Get the agent associated with the current API key")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/agents/me");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("inbox-lite")
      .description("Get a lightweight inbox snapshot for the current agent")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/agents/me/inbox-lite");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("inbox-mine")
      .description("Get the issues inbox for a given user (board)")
      .requiredOption("--user-id <id>", "User ID")
      .option("--status <filter>", "Status filter")
      .action(async (opts: MineInboxOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const parsed = agentMineInboxQuerySchema.parse({
            userId: opts.userId,
            ...(opts.status !== undefined ? { status: opts.status } : {}),
          });
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(parsed)) {
            if (v !== undefined) params.set(k, String(v));
          }
          const row = await ctx.api.get<unknown>(
            `/api/agents/me/inbox/mine?${params.toString()}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── per-company agent metadata ──────────────────────────────────────────
  addCommonClientOptions(
    agent
      .command("configurations")
      .description("List agent configurations for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOnly) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/agent-configurations`,
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
      .command("org")
      .description("Get the org chart for a company (JSON)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOnly) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/org`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── configuration / config-revisions ────────────────────────────────────
  addCommonClientOptions(
    agent
      .command("configuration")
      .description("Get an agent's resolved configuration")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/configuration`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const revision = agent.command("config-revision").description("Agent config revision history");

  addCommonClientOptions(
    revision
      .command("list")
      .description("List config revisions for an agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/agents/${encodeURIComponent(agentId)}/config-revisions`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    revision
      .command("get")
      .description("Get a single config revision")
      .argument("<agentId>", "Agent ID")
      .argument("<revisionId>", "Revision ID")
      .action(async (agentId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/config-revisions/${encodeURIComponent(revisionId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    revision
      .command("rollback")
      .description("Roll an agent's config back to a prior revision")
      .argument("<agentId>", "Agent ID")
      .argument("<revisionId>", "Revision ID")
      .action(async (agentId: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/config-revisions/${encodeURIComponent(revisionId)}/rollback`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── runtime state / sessions ────────────────────────────────────────────
  addCommonClientOptions(
    agent
      .command("runtime-state")
      .description("Get an agent's runtime state")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/runtime-state`,
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
      .command("task-sessions")
      .description("List task sessions for an agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/agents/${encodeURIComponent(agentId)}/task-sessions`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    agent
      .command("reset-session")
      .description("Reset an agent's session (optionally for a specific task key)")
      .argument("<agentId>", "Agent ID")
      .option("--task-key <key>", "Reset only this task key")
      .action(async (agentId: string, opts: RunResetSessionOptions) => {
        try {
          const payload: Record<string, unknown> = {};
          if (opts.taskKey !== undefined) payload.taskKey = opts.taskKey;
          const parsed = resetAgentSessionSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/runtime-state/reset-session`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── hires ───────────────────────────────────────────────────────────────
  addCommonClientOptions(
    agent
      .command("hire")
      .description("Hire an agent (extended createAgent with optional source issues)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--payload <json>", "Hire payload as JSON object")
      .option("--payload-file <path>", "Read hire payload from JSON file")
      .action(async (opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = createAgentHireSchema.parse(payload);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/agent-hires`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── skills ──────────────────────────────────────────────────────────────
  const skill = agent.command("skill").description("Agent skill operations");

  addCommonClientOptions(
    skill
      .command("list")
      .description("List skills resolved for an agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/skills`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    skill
      .command("sync")
      .description("Replace an agent's desired-skills list")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--desired-skills <list>", "Comma-separated skill names")
      .action(async (agentId: string, opts: SkillsSetOptions) => {
        try {
          const desired = opts.desiredSkills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const parsed = agentSkillSyncSchema.parse({ desiredSkills: desired });
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/skills/sync`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── instructions bundle ─────────────────────────────────────────────────
  const instr = agent.command("instructions").description("Agent instructions bundle operations");

  addCommonClientOptions(
    instr
      .command("path")
      .description("Update the agent's instructions path inside its adapter config")
      .argument("<agentId>", "Agent ID")
      .option("--path <path>", "New instructions path")
      .option("--unset", "Clear the instructions path (sets to null)")
      .option("--adapter-config-key <key>", "Adapter config key to write to")
      .action(async (agentId: string, opts: InstructionsPathOptions) => {
        try {
          if (opts.path !== undefined && opts.unset) {
            throw new Error("Pass either --path or --unset, not both.");
          }
          const payload: Record<string, unknown> = {
            path: opts.unset ? null : opts.path,
          };
          if (opts.adapterConfigKey !== undefined) payload.adapterConfigKey = opts.adapterConfigKey;
          const parsed = updateAgentInstructionsPathSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.patch<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/instructions-path`,
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
    instr
      .command("bundle-get")
      .description("Get an agent's instructions bundle metadata")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/instructions-bundle`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    instr
      .command("bundle-update")
      .description("Update agent's instructions bundle settings")
      .argument("<agentId>", "Agent ID")
      .option("--mode <mode>", "Bundle mode (managed | external)")
      .option("--root-path <path>", "External root path")
      .option("--unset-root-path", "Clear external root path")
      .option("--entry-file <name>", "Entry file name")
      .option("--clear-legacy-prompt-template", "Clear legacy prompt template")
      .action(async (agentId: string, opts: InstructionsBundleUpdateOptions) => {
        try {
          if (opts.rootPath !== undefined && opts.unsetRootPath) {
            throw new Error("Pass either --root-path or --unset-root-path, not both.");
          }
          const payload: Record<string, unknown> = {};
          if (opts.mode !== undefined) payload.mode = opts.mode;
          if (opts.rootPath !== undefined) payload.rootPath = opts.rootPath;
          else if (opts.unsetRootPath) payload.rootPath = null;
          if (opts.entryFile !== undefined) payload.entryFile = opts.entryFile;
          if (opts.clearLegacyPromptTemplate) payload.clearLegacyPromptTemplate = true;
          const parsed = updateAgentInstructionsBundleSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.patch<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/instructions-bundle`,
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
    instr
      .command("file-get")
      .description("Read one file from the bundle")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <relative>", "File path within the bundle")
      .action(async (agentId: string, opts: InstructionsFileGetOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams({ path: opts.path });
          const row = await ctx.api.get<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?${params.toString()}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    instr
      .command("file-upsert")
      .description("Create/replace a file in the bundle")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <relative>", "File path within the bundle")
      .option("--content <text>", "New content")
      .option("--content-file <path>", "Read content from file")
      .option("--clear-legacy-prompt-template", "Clear legacy prompt template")
      .action(async (agentId: string, opts: InstructionsFileUpsertOptions) => {
        try {
          if (opts.content !== undefined && opts.contentFile !== undefined) {
            throw new Error("Pass either --content or --content-file, not both.");
          }
          let content: string;
          if (opts.contentFile !== undefined) {
            content = readFileSync(opts.contentFile, "utf8");
          } else if (opts.content !== undefined) {
            content = opts.content;
          } else {
            throw new Error("Pass --content or --content-file.");
          }
          const payload: Record<string, unknown> = { path: opts.path, content };
          if (opts.clearLegacyPromptTemplate) payload.clearLegacyPromptTemplate = true;
          const parsed = upsertAgentInstructionsFileSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.put<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file`,
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
    instr
      .command("file-delete")
      .description("Delete a file from the bundle")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--path <relative>", "File path within the bundle")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (agentId: string, opts: InstructionsFileDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(`Delete ${opts.path} from agent ${agentId}'s bundle?`);
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams({ path: opts.path });
          const row = await ctx.api.delete<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?${params.toString()}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── heartbeat invoke + claude login ─────────────────────────────────────
  addCommonClientOptions(
    agent
      .command("heartbeat-invoke")
      .description("Invoke a one-off heartbeat for an agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/heartbeat/invoke`,
            {},
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
      .command("claude-login")
      .description("Trigger a Claude login flow for the agent")
      .argument("<agentId>", "Agent ID")
      .action(async (agentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/claude-login`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── instance scheduler heartbeats ───────────────────────────────────────
  addCommonClientOptions(
    agent
      .command("scheduler-heartbeats")
      .description("Get instance-level scheduler heartbeats")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/instance/scheduler-heartbeats");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
