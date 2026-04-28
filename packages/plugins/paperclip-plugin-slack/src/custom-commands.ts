import type { PluginContext } from "@paperclipai/plugin-sdk";
import { postMessage, respondEphemeral } from "./slack-api.js";
import { STATE_KEYS } from "./constants.js";
import type { CommandDefinition, CommandStep } from "./types.js";

// --- Command registry ---
async function getCommands(
  ctx: PluginContext,
  companyId: string,
): Promise<CommandDefinition[]> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: STATE_KEYS.commandRegistry,
  });
  if (Array.isArray(raw))
    return raw as CommandDefinition[];
  return [];
}
async function setCommands(
  ctx: PluginContext,
  companyId: string,
  commands: CommandDefinition[],
): Promise<void> {
  await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: STATE_KEYS.commandRegistry }, commands);
}
// --- Command registration ---
export async function registerCommand(
  ctx: PluginContext,
  companyId: string,
  command: CommandDefinition,
): Promise<boolean> {
  const commands = await getCommands(ctx, companyId);
  // Replace if exists, add if new
  const idx = commands.findIndex((c) => c.name === command.name);
  if (idx >= 0) {
    commands[idx] = command;
  }
  else {
    commands.push(command);
  }
  await setCommands(ctx, companyId, commands);
  ctx.logger.info("Custom command registered", { name: command.name });
  return true;
}
export async function unregisterCommand(
  ctx: PluginContext,
  companyId: string,
  name: string,
): Promise<boolean> {
  const commands = await getCommands(ctx, companyId);
  const filtered = commands.filter((c) => c.name !== name);
  if (filtered.length === commands.length)
    return false;
  await setCommands(ctx, companyId, filtered);
  return true;
}
// --- Command parsing ---
export function parseCommand(text: string): { name: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("!"))
    return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0]?.toLowerCase();
  if (!name)
    return null;
  return { name, args: parts.slice(1) };
}
// --- Command execution (workflow steps) ---
export async function executeCommand(
  ctx: PluginContext,
  token: string,
  companyId: string,
  channelId: string,
  threadTs: string,
  command: CommandDefinition,
  args: string[],
): Promise<void> {
  ctx.logger.info("Executing custom command", { name: command.name, args });
  await postMessage(ctx, token, channelId, {
    text: `Running command: !${command.name}`,
    blocks: [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `:gear: Running *!${command.name}*... (${command.steps.length} step(s))` },
        ],
      },
    ],
  }, { threadTs });
  for (let i = 0; i < command.steps.length; i++) {
    const step = command.steps[i];
    const stepLabel = `Step ${i + 1}/${command.steps.length}`;
    try {
      await executeStep(ctx, token, companyId, channelId, threadTs, step, args, stepLabel);
    }
    catch (err) {
      ctx.logger.warn("Command step failed", { name: command.name, step: i, err });
      await postMessage(ctx, token, channelId, {
        text: `Command !${command.name} failed at step ${i + 1}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:x: *!${command.name}* failed at ${stepLabel}\n\`\`\`${String(err)}\`\`\``,
            },
          },
        ],
      }, { threadTs });
      return;
    }
  }
  await postMessage(ctx, token, channelId, {
    text: `Command !${command.name} completed`,
    blocks: [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `:white_check_mark: *!${command.name}* completed successfully` },
        ],
      },
    ],
  }, { threadTs });
  await ctx.metrics.write("slack.commands.custom.executed", 1, { command_name: command.name });
}
async function executeStep(
  ctx: PluginContext,
  token: string,
  companyId: string,
  channelId: string,
  threadTs: string,
  step: CommandStep,
  args: string[],
  stepLabel: string,
): Promise<void> {
  switch (step.type) {
    case "invoke_agent": {
      if (!step.agentId)
        throw new Error("invoke_agent step requires agentId");
      const prompt = interpolateArgs(step.prompt ?? "", args);
      const result = await ctx.agents.invoke(step.agentId, companyId, {
        prompt,
        reason: `Custom command step: ${stepLabel}`,
      });
      await postMessage(ctx, token, channelId, {
        text: `${stepLabel}: Agent ${step.agentId} invoked`,
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `${stepLabel}: Invoked *${step.agentId}* (run: \`${result.runId}\`)` },
            ],
          },
        ],
      }, { threadTs });
      break;
    }
    case "post_message": {
      const message = interpolateArgs(step.message ?? "", args);
      await postMessage(ctx, token, channelId, {
        text: message,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: message },
          },
        ],
      }, { threadTs });
      break;
    }
    case "create_issue": {
      const title = interpolateArgs(step.issueTitle ?? args.join(" "), args);
      const description = interpolateArgs(step.issueDescription ?? "", args);
      await ctx.http.fetch(`${ctx.config ? "" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, companyId }),
      });
      await postMessage(ctx, token, channelId, {
        text: `${stepLabel}: Issue created - ${title}`,
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `${stepLabel}: Created issue *${title}*` },
            ],
          },
        ],
      }, { threadTs });
      break;
    }
    case "wait_approval": {
      const timeout = step.timeout ?? 300000;
      await postMessage(ctx, token, channelId, {
        text: `${stepLabel}: Waiting for approval...`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${stepLabel}: *Waiting for approval* (timeout: ${Math.round(timeout / 1000)}s)`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Approve" },
                style: "primary",
                action_id: "command_step_approve",
                value: `${channelId}:${threadTs}:${stepLabel}`,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Reject" },
                style: "danger",
                action_id: "command_step_reject",
                value: `${channelId}:${threadTs}:${stepLabel}`,
              },
            ],
          },
        ],
      }, { threadTs });
      break;
    }
    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}
function interpolateArgs(template: string, args: string[]): string {
  let result = template;
  for (let i = 0; i < args.length; i++) {
    result = result.replace(new RegExp(`\\$\\{${i + 1}\\}`, "g"), args[i]);
    result = result.replace(new RegExp(`\\$${i + 1}`, "g"), args[i]);
  }
  result = result.replace(/\$\{args\}/g, args.join(" "));
  result = result.replace(/\$args/g, args.join(" "));
  return result;
}
// --- Handle command list slash subcommand ---
export async function handleCommandsSlash(
  ctx: PluginContext,
  companyId: string,
  responseUrl: string,
): Promise<void> {
  const commands = await getCommands(ctx, companyId);
  if (commands.length === 0) {
    await respondEphemeral(ctx, responseUrl, {
      text: "No custom commands registered. Use the `register_command` tool to add commands.",
    });
    return;
  }
  const lines = commands.map((c) => `\`!${c.name}\` - ${c.description}\n  Usage: \`${c.usage}\``);
  await respondEphemeral(ctx, responseUrl, {
    text: `${commands.length} custom command(s)`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Custom Commands (${commands.length})` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n\n") },
      },
    ],
  });
}
// --- Try to handle message as custom command ---
export async function tryCustomCommand(
  ctx: PluginContext,
  token: string,
  companyId: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<boolean> {
  const parsed = parseCommand(text);
  if (!parsed)
    return false;
  const commands = await getCommands(ctx, companyId);
  const command = commands.find((c) => c.name === parsed.name);
  if (!command)
    return false;
  await executeCommand(ctx, token, companyId, channelId, threadTs, command, parsed.args);
  return true;
}
