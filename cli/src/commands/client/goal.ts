import { Command } from "commander";
import {
  createGoalSchema,
  updateGoalSchema,
  type Goal,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface GoalListOptions extends BaseClientOptions {
  companyId?: string;
}

interface GoalCreateOptions extends BaseClientOptions {
  companyId?: string;
  title: string;
  description?: string;
  level?: string;
  status?: string;
  parentId?: string;
  ownerAgentId?: string;
}

interface GoalUpdateOptions extends BaseClientOptions {
  title?: string;
  description?: string;
  level?: string;
  status?: string;
  parentId?: string;
  ownerAgentId?: string;
}

interface GoalDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

export function registerGoalCommands(program: Command): void {
  const goal = program.command("goal").description("Goal operations");

  addCommonClientOptions(
    goal
      .command("list")
      .description("List goals for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: GoalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows =
            (await ctx.api.get<Goal[]>(`/api/companies/${ctx.companyId}/goals`)) ?? [];

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
                title: row.title,
                level: row.level,
                status: row.status,
                parentId: row.parentId,
                ownerAgentId: row.ownerAgentId,
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
    goal
      .command("get")
      .description("Get one goal")
      .argument("<goalId>", "Goal ID")
      .action(async (goalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Goal>(`/api/goals/${encodeURIComponent(goalId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    goal
      .command("create")
      .description("Create a new goal in a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--title <title>", "Goal title")
      .option("--description <text>", "Goal description")
      .option("--level <level>", "Goal level (e.g. mission, strategy, task)")
      .option("--status <status>", "Goal status (e.g. planned, active, done)")
      .option("--parent-id <id>", "Parent goal ID")
      .option("--owner-agent-id <id>", "Owner agent ID")
      .action(async (opts: GoalCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload: Record<string, unknown> = { title: opts.title };
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.level !== undefined) payload.level = opts.level;
          if (opts.status !== undefined) payload.status = opts.status;
          if (opts.parentId !== undefined) payload.parentId = opts.parentId;
          if (opts.ownerAgentId !== undefined) payload.ownerAgentId = opts.ownerAgentId;

          const parsed = createGoalSchema.parse(payload);
          const row = await ctx.api.post<Goal>(
            `/api/companies/${ctx.companyId}/goals`,
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
    goal
      .command("update")
      .description("Update a goal")
      .argument("<goalId>", "Goal ID")
      .option("--title <title>", "New title")
      .option("--description <text>", "New description")
      .option("--level <level>", "New level")
      .option("--status <status>", "New status")
      .option("--parent-id <id>", "New parent goal ID")
      .option("--owner-agent-id <id>", "New owner agent ID")
      .action(async (goalId: string, opts: GoalUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.title !== undefined) payload.title = opts.title;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.level !== undefined) payload.level = opts.level;
          if (opts.status !== undefined) payload.status = opts.status;
          if (opts.parentId !== undefined) payload.parentId = opts.parentId;
          if (opts.ownerAgentId !== undefined) payload.ownerAgentId = opts.ownerAgentId;

          const parsed = updateGoalSchema.parse(payload);
          const row = await ctx.api.patch<Goal>(
            `/api/goals/${encodeURIComponent(goalId)}`,
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
    goal
      .command("delete")
      .description("Delete a goal")
      .argument("<goalId>", "Goal ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (goalId: string, opts: GoalDeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const { confirm } = await import("@clack/prompts");
            const answer = await confirm({
              message: `Delete goal ${goalId}? This cannot be undone.`,
              initialValue: false,
            });
            if (answer !== true) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<Goal>(`/api/goals/${encodeURIComponent(goalId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
