import { Command } from "commander";
import type { Agent, Issue, IssueComment } from "@paperclipai/shared";
import { addIssueCommentSchema, createIssueSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface PromptOptions extends BaseClientOptions {
  agent?: string;
  apiKeyEnv?: string;
  issue?: string;
  title?: string;
  wake?: boolean;
  companyId?: string;
}

interface PromptResult {
  ok: true;
  mode: "issue" | "comment";
  actor: "agent" | "board";
  apiBase: string;
  companyId: string;
  agent: {
    id: string;
    name: string;
    urlKey?: string | null;
  };
  issue?: Issue | null;
  comment?: IssueComment | null;
  wakeup?: unknown;
}

export function registerPromptCommands(program: Command): void {
  addCommonClientOptions(
    program
      .command("agent-prompt")
      .description("Create/update Paperclip work for an agent using an agent API key")
      .argument("<agent>", "Agent ID, shortname, or name")
      .argument("<agentApiKey>", "Agent API key")
      .argument("<prompt...>", "Prompt text")
      .option("--issue <issueId>", "Append as a comment to an existing issue")
      .option("--title <title>", "Issue title when creating a new issue")
      .option("--no-wake", "Do not wake the agent after creating/updating work")
      .action(async (agent: string, agentApiKey: string, promptParts: string[], opts: PromptOptions) => {
        try {
          const result = await runAgentPrompt(agent, promptParts.join(" "), {
            ...opts,
            apiKey: agentApiKey,
            wake: opts.wake,
          });
          printOutput(result, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const agent = program.commands.find((cmd) => cmd.name() === "agent") ?? program.command("agent");
  addCommonClientOptions(
    agent
      .command("prompt")
      .description("Create/update Paperclip work using an agent persona")
      .argument("<prompt...>", "Prompt text")
      .option("--agent <agent>", "Agent ID, shortname, or name; defaults to profile/identity agent")
      .option("--api-key-env <name>", "Read the agent API key from this environment variable")
      .option("--issue <issueId>", "Append as a comment to an existing issue")
      .option("--title <title>", "Issue title when creating a new issue")
      .option("--no-wake", "Do not wake the agent after creating/updating work")
      .action(async (promptParts: string[], opts: PromptOptions) => {
        try {
          const apiKey = readApiKeyEnvOption(opts);
          const result = await runAgentPrompt(opts.agent, promptParts.join(" "), {
            ...opts,
            apiKey: apiKey ?? opts.apiKey,
            wake: opts.wake,
          });
          printOutput(result, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const board = program.command("board").description("Board operator operations");
  addCommonClientOptions(
    board
      .command("prompt")
      .description("Create/update Paperclip work for an agent using board auth")
      .requiredOption("--agent <agent>", "Target agent ID, shortname, or name")
      .option("-C, --company-id <id>", "Company ID")
      .option("--issue <issueId>", "Append as a comment to an existing issue")
      .option("--title <title>", "Issue title when creating a new issue")
      .option("--no-wake", "Do not wake the agent after creating/updating work")
      .argument("<prompt...>", "Prompt text")
      .action(async (promptParts: string[], opts: PromptOptions) => {
        try {
          const result = await runBoardPrompt(opts.agent ?? "", promptParts.join(" "), opts);
          printOutput(result, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

export async function runAgentPrompt(
  agentRef: string | undefined,
  prompt: string,
  opts: PromptOptions,
): Promise<PromptResult> {
  const ctx = resolveCommandContext(opts);
  if (ctx.profile.persona && ctx.profile.persona !== "agent") {
    throw new Error(`Profile '${ctx.profileName}' is persona=${ctx.profile.persona}; use an agent profile or board prompt.`);
  }
  const body = normalizePrompt(prompt);
  const me = await ctx.api.get<Agent>("/api/agents/me");
  if (!me) throw new Error("Agent authentication failed");
  const expectedRef = agentRef?.trim() || ctx.profile.agentId || me.id;
  assertAgentMatchesReference(me, expectedRef);

  const result = await createOrCommentForAgent({
    api: ctx.api,
    actor: "agent",
    agent: me,
    companyId: me.companyId,
    prompt: body,
    issueId: opts.issue,
    title: opts.title,
    wake: opts.wake !== false,
  });
  return result;
}

export async function runBoardPrompt(
  agentRef: string,
  prompt: string,
  opts: PromptOptions,
): Promise<PromptResult> {
  const ctx = resolveCommandContext(opts, { requireCompany: true });
  if (ctx.profile.persona && ctx.profile.persona !== "board") {
    throw new Error(`Profile '${ctx.profileName}' is persona=${ctx.profile.persona}; use an agent prompt command or a board profile.`);
  }
  const body = normalizePrompt(prompt);
  const query = new URLSearchParams({ companyId: ctx.companyId ?? "" });
  const agent = await ctx.api.get<Agent>(`${apiPath`/api/agents/${agentRef}`}?${query.toString()}`);
  if (!agent) throw new Error(`Agent not found: ${agentRef}`);

  return createOrCommentForAgent({
    api: ctx.api,
    actor: "board",
    agent,
    companyId: ctx.companyId ?? agent.companyId,
    prompt: body,
    issueId: opts.issue,
    title: opts.title,
    wake: opts.wake !== false,
  });
}

async function createOrCommentForAgent(input: {
  api: {
    apiBase: string;
    post<T>(path: string, body?: unknown): Promise<T | null>;
  };
  actor: "agent" | "board";
  agent: Agent;
  companyId: string;
  prompt: string;
  issueId?: string;
  title?: string;
  wake: boolean;
}): Promise<PromptResult> {
  if (input.issueId?.trim()) {
    const payload = addIssueCommentSchema.parse({
      body: input.prompt,
      resume: input.wake,
    });
    const comment = await input.api.post<IssueComment>(apiPath`/api/issues/${input.issueId.trim()}/comments`, payload);
    const wakeup = input.wake
      ? await wakeAgent(input.api, input.agent.id, input.issueId.trim(), "Prompt comment handoff")
      : null;
    return {
      ok: true,
      mode: "comment",
      actor: input.actor,
      apiBase: input.api.apiBase,
      companyId: input.companyId,
      agent: agentSummary(input.agent),
      comment,
      wakeup,
    };
  }

  const payload = createIssueSchema.parse({
    title: input.title?.trim() || defaultPromptTitle(input.prompt),
    description: input.prompt,
    status: "todo",
    priority: "medium",
    assigneeAgentId: input.agent.id,
  });
  const issue = await input.api.post<Issue>(apiPath`/api/companies/${input.companyId}/issues`, payload);
  const wakeup = input.wake && issue?.id
    ? await wakeAgent(input.api, input.agent.id, issue.id, "Prompt issue handoff")
    : null;
  return {
    ok: true,
    mode: "issue",
    actor: input.actor,
    apiBase: input.api.apiBase,
    companyId: input.companyId,
    agent: agentSummary(input.agent),
    issue,
    wakeup,
  };
}

function wakeAgent(
  api: { post<T>(path: string, body?: unknown): Promise<T | null> },
  agentId: string,
  issueId: string,
  reason: string,
): Promise<unknown> {
  return api.post(apiPath`/api/agents/${agentId}/wakeup`, {
    source: "on_demand",
    triggerDetail: "manual",
    reason,
    payload: { issueId },
  });
}

function normalizePrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) throw new Error("Prompt text is required");
  return normalized;
}

function defaultPromptTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Prompt handoff";
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

function assertAgentMatchesReference(agent: Agent, reference: string): void {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) throw new Error("Agent reference is required");
  const matches = [
    agent.id,
    agent.name,
    typeof agent.urlKey === "string" ? agent.urlKey : null,
  ].some((value) => value?.toLowerCase() === normalized);
  if (!matches) {
    throw new Error(
      `Agent key belongs to ${agent.name} (${agent.id}), not '${reference}'. Use the matching agent or a board prompt.`,
    );
  }
}

function agentSummary(agent: Agent): PromptResult["agent"] {
  return {
    id: agent.id,
    name: agent.name,
    urlKey: typeof agent.urlKey === "string" ? agent.urlKey : null,
  };
}

function readApiKeyEnvOption(opts: PromptOptions): string | undefined {
  if (!opts.apiKeyEnv?.trim()) return undefined;
  const value = process.env[opts.apiKeyEnv.trim()]?.trim();
  if (!value) throw new Error(`Environment variable ${opts.apiKeyEnv.trim()} is not set`);
  return value;
}
