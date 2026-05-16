import { Command } from "commander";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

function getApprovalCommand(program: Command): Command {
  const cmd = program.commands.find((c) => c.name() === "approval");
  if (!cmd) throw new Error("approval command not registered yet; load order error");
  return cmd;
}

export function registerApprovalExtensionCommands(program: Command): void {
  const approval = getApprovalCommand(program);

  addCommonClientOptions(
    approval
      .command("issues")
      .description("List issues linked to an approval")
      .argument("<approvalId>", "Approval ID")
      .action(async (approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/approvals/${encodeURIComponent(approvalId)}/issues`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    approval
      .command("comments")
      .description("List comments on an approval")
      .argument("<approvalId>", "Approval ID")
      .action(async (approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/approvals/${encodeURIComponent(approvalId)}/comments`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
