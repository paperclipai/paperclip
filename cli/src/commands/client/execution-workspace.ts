import { Command } from "commander";
import {
  reapExecutionWorkspacesSchema,
  type ExecutionWorkspaceReapReport,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface ExecutionWorkspaceReapOptions extends BaseClientOptions {
  dryRun?: boolean;
  apply?: boolean;
  deleteFiles?: boolean;
}

export function registerExecutionWorkspaceCommands(program: Command): void {
  const executionWorkspace = program
    .command("execution-workspace")
    .description("Execution workspace operations");

  addCommonClientOptions(
    executionWorkspace
      .command("reap")
      .description("Dry-run or archive conservative execution-workspace cleanup candidates")
      .option("-C, --company-id <id>", "Company ID")
      .option("--dry-run", "Only list planned actions")
      .option("--apply", "Archive eligible DB records")
      .option("--delete-files", "After archiving, delete eligible filesystem workspaces that pass close-readiness checks")
      .action(async (opts: ExecutionWorkspaceReapOptions, command: Command) => {
        try {
          if (opts.apply && command.getOptionValueSource("dryRun") === "cli") {
            throw new Error("Choose either --apply or --dry-run, not both.");
          }
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const deleteFiles = opts.deleteFiles ?? false;
          const path = `/api/companies/${ctx.companyId}/execution-workspaces/reap`;
          const report = opts.apply
            ? await ctx.api.post<ExecutionWorkspaceReapReport>(
                path,
                reapExecutionWorkspacesSchema.parse({
                  dryRun: false,
                  deleteFiles,
                }),
              )
            : await ctx.api.get<ExecutionWorkspaceReapReport>(
                deleteFiles ? `${path}?deleteFiles=true` : path,
              );
          if (ctx.json) {
            printOutput(report, { json: true });
            return;
          }
          if (!report || report.items.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const item of report.items) {
            console.log(formatInlineRecord({
              id: item.workspaceId,
              status: item.workspaceStatus,
              sourceIssueIdentifier: item.sourceIssueIdentifier,
              sourceIssueStatus: item.sourceIssueStatus,
              reason: item.reason,
              pathExists: item.pathExists,
              activeLinkedCount: item.activeLinkedCount,
              action: item.plannedAction,
              archived: item.archived,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
