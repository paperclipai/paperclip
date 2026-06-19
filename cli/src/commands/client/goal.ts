import { Command } from "commander";
import type { Goal } from "@paperclipai/shared";
import { createGoalSchema, updateGoalSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
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
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: GoalListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Goal[]>(apiPath`/api/companies/${ctx.companyId}/goals`)) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              id: row.id,
              status: row.status,
              title: row.title,
              level: row.level,
              parentId: row.parentId,
              ownerAgentId: row.ownerAgentId,
            }));
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
          const row = await ctx.api.get<Goal>(apiPath`/api/goals/${goalId}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    goal
      .command("create")
      .description("Create a goal")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--title <title>", "Goal title")
      .option("--description <text>", "Goal description")
      .option("--level <level>", "Goal level")
      .option("--status <status>", "Goal status")
      .option("--parent-id <id>", "Parent goal ID")
      .option("--owner-agent-id <id>", "Owner agent ID")
      .action(async (opts: GoalCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createGoalSchema.parse({
            title: opts.title,
            description: opts.description,
            level: opts.level,
            status: opts.status,
            parentId: parseNullableString(opts.parentId),
            ownerAgentId: parseNullableString(opts.ownerAgentId),
          });
          const created = await ctx.api.post<Goal>(apiPath`/api/companies/${ctx.companyId}/goals`, payload);
          printOutput(created, { json: ctx.json });
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
      .option("--title <title>", "Goal title")
      .option("--description <text|null>", "Goal description")
      .option("--level <level>", "Goal level")
      .option("--status <status>", "Goal status")
      .option("--parent-id <id|null>", "Parent goal ID")
      .option("--owner-agent-id <id|null>", "Owner agent ID")
      .action(async (goalId: string, opts: GoalUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateGoalSchema.parse({
            title: opts.title,
            description: parseNullableString(opts.description),
            level: opts.level,
            status: opts.status,
            parentId: parseNullableString(opts.parentId),
            ownerAgentId: parseNullableString(opts.ownerAgentId),
          });
          const updated = await ctx.api.patch<Goal>(apiPath`/api/goals/${goalId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    goal
      .command("delete")
      .description("Delete a goal")
      .argument("<goalId>", "Goal ID")
      .option("--yes", "Confirm deletion")
      .action(async (goalId: string, opts: GoalDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("Deletion requires --yes.");
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<Goal>(apiPath`/api/goals/${goalId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseNullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.trim().toLowerCase() === "null" ? null : value;
}
