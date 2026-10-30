import { Command } from "commander";
import type { ActivityEvent } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface ActivityListOptions extends BaseClientOptions {
  companyId?: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
  payloadJson?: string;
}

export function registerActivityCommands(program: Command): void {
  const activity = program.command("activity").description("Activity log operations");

  addCommonClientOptions(
    activity
      .command("list")
      .description("List company activity log entries")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--agent-id <id>", "Filter by agent ID")
      .option("--entity-type <type>", "Filter by entity type")
      .option("--entity-id <id>", "Filter by entity ID")
      .action(async (opts: ActivityListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.agentId) params.set("agentId", opts.agentId);
          if (opts.entityType) params.set("entityType", opts.entityType);
          if (opts.entityId) params.set("entityId", opts.entityId);

          const query = params.toString();
          const path = `${apiPath`/api/companies/${ctx.companyId}/activity`}${query ? `?${query}` : ""}`;
          const rows = (await ctx.api.get<ActivityEvent[]>(path)) ?? [];

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
                action: row.action,
                actorType: row.actorType,
                actorId: row.actorId,
                entityType: row.entityType,
                entityId: row.entityId,
                createdAt: String(row.createdAt),
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
    activity
      .command("create")
      .description("Create a company activity log entry")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "CreateActivity JSON payload")
      .action(async (opts: ActivityListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/activity`, parseJson(opts.payloadJson ?? "{}"));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    activity
      .command("issue")
      .description("List activity for an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/issues/${issueId}/activity`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
