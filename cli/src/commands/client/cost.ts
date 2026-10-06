import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOptions extends BaseClientOptions {
  companyId?: string;
}

interface JsonPayloadOptions extends CompanyOptions {
  payloadJson: string;
}

interface IncidentOptions extends CompanyOptions {
  payloadJson?: string;
}

export function registerCostCommands(program: Command): void {
  const cost = program.command("cost").description("Cost and finance operations");

  for (const [name, path] of [
    ["summary", "costs/summary"],
    ["by-agent", "costs/by-agent"],
    ["by-agent-model", "costs/by-agent-model"],
    ["by-provider", "costs/by-provider"],
    ["by-biller", "costs/by-biller"],
    ["by-project", "costs/by-project"],
    ["window-spend", "costs/window-spend"],
    ["quota-windows", "costs/quota-windows"],
  ] as const) {
    addCompanyGet(cost, name, `Get ${name} cost data`, path);
  }

  addCommonClientOptions(
    cost
      .command("issue")
      .description("Get cost summary for an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/issues/${issueId}/cost-summary`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCompanyPostJson(cost, "event:create", "Record a cost event", "cost-events");

  addCommonClientOptions(
    cost
      .command("tail")
      .description(
        "Read cost events from the workspace-relative mirror file (<cwd>/.changes/<YYYY-MM-DD>/cost-events.ndjson)",
      )
      .argument("<project>", "Project ID or shortname")
      .option("-C, --company-id <id>", "Company ID (for shortname lookup)")
      .option("--since <duration>", "Show events newer than this (e.g. 1h, 30m, 7d, 2026-10-01)", "1h")
      .option("--until <duration>", "Upper bound; defaults to now")
      .option("--limit <n>", "Maximum number of events to print", "500")
      .action(
        async (
          projectRef: string,
          opts: BaseClientOptions & {
            companyId?: string;
            since?: string;
            until?: string;
            limit?: string;
          },
        ) => {
          try {
            const ctx = resolveCommandContext(opts, { requireCompany: true });
            const project = await ctx.api.get<{ id: string } | null>(
              apiPath`/api/projects/${projectRef}` +
                (ctx.companyId ? `?companyId=${encodeURIComponent(ctx.companyId)}` : ""),
            );
            if (!project || !project.id) {
              throw new Error(`Project not found: ${projectRef}`);
            }
            const params = new URLSearchParams();
            if (opts.since) params.set("since", opts.since);
            if (opts.until) params.set("until", opts.until);
            if (opts.limit) params.set("limit", opts.limit);
            const query = params.toString();
            const result = (await ctx.api.get(
              `${apiPath`/api/projects/${project.id}/cost-events`}${query ? `?${query}` : ""}`,
            )) as { projectId: string; cwd: string | null; events: string[] };
            if (ctx.json) {
              printOutput(result, { json: true });
              return;
            }
            if (!result.cwd) {
              console.error(`No primary workspace cwd for project ${result.projectId}; nothing to tail.`);
              return;
            }
            if (result.events.length === 0) {
              console.log(`(no cost events in ${result.cwd}/.changes since ${opts.since ?? "1h"})`);
              return;
            }
            for (const line of result.events) {
              process.stdout.write(`${line}\n`);
            }
          } catch (err) {
            handleCommandError(err);
          }
        },
      ),
    { includeCompany: false },
  );

  const finance = program.command("finance").description("Finance event and summary operations");
  addCompanyPostJson(finance, "event:create", "Record a finance event", "finance-events");
  addCompanyGet(finance, "events", "List finance events", "costs/finance-events");
  addCompanyGet(finance, "summary", "Get finance summary", "costs/finance-summary");
  addCompanyGet(finance, "by-biller", "Get finance summary by biller", "costs/finance-by-biller");
  addCompanyGet(finance, "by-kind", "Get finance summary by kind", "costs/finance-by-kind");

  const budget = program.command("budget").description("Budget policy and incident operations");
  addCompanyGet(budget, "overview", "Get budget overview", "budgets/overview");
  addCompanyPostJson(budget, "policy:upsert", "Create or update a budget policy", "budgets/policies");

  addCommonClientOptions(
    budget
      .command("company:update")
      .description("Update company budget")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "UpdateBudget JSON payload")
      .action(async (opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.patch(apiPath`/api/companies/${ctx.companyId}/budgets`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    budget
      .command("agent:update")
      .description("Update agent budget")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--payload-json <json>", "UpdateBudget JSON payload")
      .action(async (agentId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.patch(apiPath`/api/agents/${agentId}/budgets`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    budget
      .command("incident:resolve")
      .description("Resolve a budget incident")
      .argument("<incidentId>", "Budget incident ID")
      .option("-C, --company-id <id>", "Company ID")
      .option("--payload-json <json>", "ResolveBudgetIncident JSON payload", "{}")
      .action(async (incidentId: string, opts: IncidentOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(
            apiPath`/api/companies/${ctx.companyId}/budget-incidents/${incidentId}/resolve`,
            parseJson(opts.payloadJson ?? "{}"),
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function addCompanyPostJson(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent
      .command(name)
      .description(description)
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--payload-json <json>", "JSON payload")
      .action(async (opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson));
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
