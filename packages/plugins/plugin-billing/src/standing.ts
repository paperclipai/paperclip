import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { StandingCommand } from "./domain.js";

export interface StandingSetInput {
  status: "active" | "grace" | "blocked";
  reason: string;
  message: string;
  actionUrl?: string;
}

export interface StandingWriter {
  set(companyId: string, input: StandingSetInput): Promise<void>;
  clear(companyId: string): Promise<void>;
}

export function standingWriterFromContext(ctx: PluginContext): StandingWriter {
  return {
    set: (companyId, input) => ctx.companies.setStanding(companyId, input),
    clear: (companyId) => ctx.companies.clearStanding(companyId),
  };
}

export async function applyStandingCommand(
  writer: StandingWriter,
  companyId: string,
  command: StandingCommand,
): Promise<void> {
  if (command.kind === "clear") {
    await writer.clear(companyId);
    return;
  }
  await writer.set(companyId, {
    status: command.status,
    reason: command.reason,
    message: command.message,
    ...(command.actionUrl === undefined ? {} : { actionUrl: command.actionUrl }),
  });
}
