import { Command } from "commander";
import {
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
  type BudgetIncident,
  type BudgetOverview,
  type BudgetPolicySummary,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface BudgetOverviewOptions extends BaseClientOptions {
  companyId?: string;
}

interface BudgetSetCompanyOptions extends BaseClientOptions {
  companyId?: string;
  monthlyCents: string;
}

interface BudgetSetAgentOptions extends BaseClientOptions {
  monthlyCents: string;
}

interface BudgetPolicyUpsertOptions extends BaseClientOptions {
  companyId?: string;
  scopeType: string;
  scopeId: string;
  amount: string;
  metric?: string;
  windowKind?: string;
  warnPercent?: string;
  hardStop?: string;
  notify?: string;
  active?: string;
}

interface BudgetIncidentResolveOptions extends BaseClientOptions {
  companyId?: string;
  action: string;
  amount?: string;
  decisionNote?: string;
}

function parseIntOpt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return n;
}

function parseBoolOpt(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`--${name} must be true or false`);
}

export function registerBudgetCommands(program: Command): void {
  const budget = program.command("budget").description("Budget policies and spend overview");

  addCommonClientOptions(
    budget
      .command("overview")
      .description("Budget policies, observed spend, active incidents")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BudgetOverviewOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<BudgetOverview>(
            `/api/companies/${ctx.companyId}/budgets/overview`,
          );

          if (ctx.json) {
            printOutput(row, { json: true });
            return;
          }
          if (!row) {
            printOutput(null, { json: false });
            return;
          }

          console.log(
            formatInlineRecord({
              companyId: row.companyId,
              policyCount: row.policies.length,
              activeIncidentCount: row.activeIncidents.length,
              pausedAgentCount: row.pausedAgentCount,
              pausedProjectCount: row.pausedProjectCount,
              pendingApprovalCount: row.pendingApprovalCount,
            }),
          );
          if (row.policies.length > 0) {
            console.log("policies:");
            for (const p of row.policies as BudgetPolicySummary[]) {
              console.log(
                "  " +
                  formatInlineRecord({
                    policyId: p.policyId,
                    scopeType: p.scopeType,
                    scopeId: p.scopeId,
                    scopeName: p.scopeName,
                    amount: p.amount,
                    observed: p.observedAmount,
                    utilization: p.utilizationPercent,
                    status: p.status,
                    paused: p.paused,
                  }),
              );
            }
          }
          if (row.activeIncidents.length > 0) {
            console.log("incidents:");
            for (const i of row.activeIncidents as BudgetIncident[]) {
              console.log(
                "  " +
                  formatInlineRecord({
                    id: i.id,
                    scopeType: i.scopeType,
                    scopeName: i.scopeName,
                    threshold: i.thresholdType,
                    limit: i.amountLimit,
                    observed: i.amountObserved,
                    status: i.status,
                  }),
              );
            }
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    budget
      .command("set-company")
      .description("Set company monthly budget (also writes a company-scoped policy)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--monthly-cents <n>", "Monthly budget in cents")
      .action(async (opts: BudgetSetCompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = updateBudgetSchema.parse({
            budgetMonthlyCents: parseIntOpt(opts.monthlyCents, "monthly-cents")!,
          });
          const row = await ctx.api.patch<unknown>(
            `/api/companies/${ctx.companyId}/budgets`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    budget
      .command("set-agent")
      .description("Set agent monthly budget (also writes an agent-scoped policy)")
      .argument("<agentId>", "Agent ID")
      .requiredOption("--monthly-cents <n>", "Monthly budget in cents")
      .action(async (agentId: string, opts: BudgetSetAgentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateBudgetSchema.parse({
            budgetMonthlyCents: parseIntOpt(opts.monthlyCents, "monthly-cents")!,
          });
          const row = await ctx.api.patch<unknown>(
            `/api/agents/${encodeURIComponent(agentId)}/budgets`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const policy = budget.command("policy").description("Budget policy operations");

  addCommonClientOptions(
    policy
      .command("upsert")
      .description("Create or update a budget policy for a scope")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--scope-type <type>", "Scope type (e.g. company, agent, project)")
      .requiredOption("--scope-id <id>", "Scope ID (UUID)")
      .requiredOption("--amount <n>", "Limit amount (cents, integer)")
      .option("--metric <metric>", "Metric (default billed_cents)")
      .option("--window-kind <kind>", "Window kind (default calendar_month_utc)")
      .option("--warn-percent <n>", "Warning threshold percent (1-99, default 80)")
      .option("--hard-stop <bool>", "Enable hard stop (true/false, default true)")
      .option("--notify <bool>", "Enable notifications (true/false, default true)")
      .option("--active <bool>", "Mark policy active (true/false, default true)")
      .action(async (opts: BudgetPolicyUpsertOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload: Record<string, unknown> = {
            scopeType: opts.scopeType,
            scopeId: opts.scopeId,
            amount: parseIntOpt(opts.amount, "amount")!,
          };
          if (opts.metric !== undefined) payload.metric = opts.metric;
          if (opts.windowKind !== undefined) payload.windowKind = opts.windowKind;
          const warn = parseIntOpt(opts.warnPercent, "warn-percent");
          if (warn !== undefined) payload.warnPercent = warn;
          const hardStop = parseBoolOpt(opts.hardStop, "hard-stop");
          if (hardStop !== undefined) payload.hardStopEnabled = hardStop;
          const notify = parseBoolOpt(opts.notify, "notify");
          if (notify !== undefined) payload.notifyEnabled = notify;
          const active = parseBoolOpt(opts.active, "active");
          if (active !== undefined) payload.isActive = active;

          const parsed = upsertBudgetPolicySchema.parse(payload);
          const row = await ctx.api.post<BudgetPolicySummary>(
            `/api/companies/${ctx.companyId}/budgets/policies`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const incident = budget.command("incident").description("Budget incident operations");

  addCommonClientOptions(
    incident
      .command("resolve")
      .description("Resolve a budget incident with a chosen action")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<incidentId>", "Incident ID")
      .requiredOption("--action <action>", "Resolution action (e.g. raise_budget_and_resume, dismiss)")
      .option("--amount <n>", "New budget amount (required for raise_budget_and_resume)")
      .option("--decision-note <text>", "Decision note")
      .action(async (incidentId: string, opts: BudgetIncidentResolveOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload: Record<string, unknown> = { action: opts.action };
          const amount = parseIntOpt(opts.amount, "amount");
          if (amount !== undefined) payload.amount = amount;
          if (opts.decisionNote !== undefined) payload.decisionNote = opts.decisionNote;

          const parsed = resolveBudgetIncidentSchema.parse(payload);
          const row = await ctx.api.post<BudgetIncident>(
            `/api/companies/${ctx.companyId}/budget-incidents/${encodeURIComponent(incidentId)}/resolve`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
