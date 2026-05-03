import { Command } from "commander";
import {
  updateExecutionWorkspaceSchema,
  workspaceRuntimeControlTargetSchema,
  type ExecutionWorkspace,
  type ExecutionWorkspaceCloseReadiness,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface WorkspaceListOptions extends BaseClientOptions {
  companyId?: string;
  projectId?: string;
  projectWorkspaceId?: string;
  issueId?: string;
  status?: string;
  reuseEligible?: boolean;
  summary?: boolean;
}

interface WorkspaceUpdateOptions extends BaseClientOptions {
  name?: string;
  cwd?: string;
  repoUrl?: string;
  baseRef?: string;
  branchName?: string;
  providerRef?: string;
  status?: string;
  cleanupEligibleAt?: string;
  cleanupReason?: string;
  workspaceConfig?: string;
  metadata?: string;
}

interface RuntimeControlOptions extends BaseClientOptions {
  action: string;
  workspaceCommandId?: string;
  runtimeServiceId?: string;
  serviceIndex?: string;
}

const RUNTIME_ACTIONS = ["start", "stop", "restart", "run"] as const;

function parseJsonObject(
  raw: string | undefined,
  name: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--${name} must be valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseIntOpt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return n;
}

function buildRuntimeTargetPayload(opts: RuntimeControlOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (opts.workspaceCommandId !== undefined) payload.workspaceCommandId = opts.workspaceCommandId;
  if (opts.runtimeServiceId !== undefined) payload.runtimeServiceId = opts.runtimeServiceId;
  const idx = parseIntOpt(opts.serviceIndex, "service-index");
  if (idx !== undefined) payload.serviceIndex = idx;
  return payload;
}

function assertRuntimeAction(action: string): void {
  if (!RUNTIME_ACTIONS.includes(action as (typeof RUNTIME_ACTIONS)[number])) {
    throw new Error(`--action must be one of: ${RUNTIME_ACTIONS.join(", ")}`);
  }
}

export function registerExecutionWorkspaceCommands(program: Command): void {
  const ws = program
    .command("execution-workspace")
    .description("Per-issue execution workspace operations");

  addCommonClientOptions(
    ws
      .command("list")
      .description("List execution workspaces for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--project-id <id>", "Filter by project")
      .option("--project-workspace-id <id>", "Filter by project workspace")
      .option("--issue-id <id>", "Filter by source issue")
      .option("--status <status>", "Filter by status")
      .option("--reuse-eligible", "Only reuse-eligible workspaces")
      .option("--summary", "Return summary rows instead of full records")
      .action(async (opts: WorkspaceListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.projectId) params.set("projectId", opts.projectId);
          if (opts.projectWorkspaceId) params.set("projectWorkspaceId", opts.projectWorkspaceId);
          if (opts.issueId) params.set("issueId", opts.issueId);
          if (opts.status) params.set("status", opts.status);
          if (opts.reuseEligible) params.set("reuseEligible", "true");
          if (opts.summary) params.set("summary", "true");
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/execution-workspaces${query}`,
          )) ?? [];

          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const r of rows as Array<Partial<ExecutionWorkspace>>) {
            console.log(
              formatInlineRecord({
                id: r.id ?? "",
                name: r.name ?? null,
                status: r.status ?? null,
                cwd: r.cwd ?? null,
                branchName: r.branchName ?? null,
                projectId: r.projectId ?? null,
                sourceIssueId: r.sourceIssueId ?? null,
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
    ws
      .command("get")
      .description("Get one execution workspace")
      .argument("<id>", "Execution workspace ID")
      .action(async (id: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<ExecutionWorkspace>(
            `/api/execution-workspaces/${encodeURIComponent(id)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    ws
      .command("close-readiness")
      .description("Inspect close readiness (blockers, planned actions, runtime services)")
      .argument("<id>", "Execution workspace ID")
      .action(async (id: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<ExecutionWorkspaceCloseReadiness>(
            `/api/execution-workspaces/${encodeURIComponent(id)}/close-readiness`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    ws
      .command("operations")
      .description("List workspace operations attached to this execution workspace")
      .argument("<id>", "Execution workspace ID")
      .action(async (id: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/execution-workspaces/${encodeURIComponent(id)}/workspace-operations`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    ws
      .command("update")
      .description("Update an execution workspace")
      .argument("<id>", "Execution workspace ID")
      .option("--name <name>", "New name")
      .option("--cwd <path>", "Local checkout path (use empty string to clear)")
      .option("--repo-url <url>", "Repo URL")
      .option("--base-ref <ref>", "Base ref")
      .option("--branch-name <name>", "Branch name")
      .option("--provider-ref <ref>", "Provider reference")
      .option("--status <status>", "Status (active, idle, in_review, archived, cleanup_failed)")
      .option("--cleanup-eligible-at <iso>", "Cleanup eligibility timestamp (or empty to clear)")
      .option("--cleanup-reason <text>", "Cleanup reason")
      .option("--workspace-config <json>", "Config patch as JSON object")
      .option("--metadata <json>", "Metadata as JSON object")
      .action(async (id: string, opts: WorkspaceUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload: Record<string, unknown> = {};
          if (opts.name !== undefined) payload.name = opts.name;
          if (opts.cwd !== undefined) payload.cwd = opts.cwd === "" ? null : opts.cwd;
          if (opts.repoUrl !== undefined) payload.repoUrl = opts.repoUrl === "" ? null : opts.repoUrl;
          if (opts.baseRef !== undefined) payload.baseRef = opts.baseRef === "" ? null : opts.baseRef;
          if (opts.branchName !== undefined)
            payload.branchName = opts.branchName === "" ? null : opts.branchName;
          if (opts.providerRef !== undefined)
            payload.providerRef = opts.providerRef === "" ? null : opts.providerRef;
          if (opts.status !== undefined) payload.status = opts.status;
          if (opts.cleanupEligibleAt !== undefined)
            payload.cleanupEligibleAt = opts.cleanupEligibleAt === "" ? null : opts.cleanupEligibleAt;
          if (opts.cleanupReason !== undefined)
            payload.cleanupReason = opts.cleanupReason === "" ? null : opts.cleanupReason;
          const config = parseJsonObject(opts.workspaceConfig, "workspace-config");
          if (config !== undefined) payload.config = config;
          const metadata = parseJsonObject(opts.metadata, "metadata");
          if (metadata !== undefined) payload.metadata = metadata;

          const parsed = updateExecutionWorkspaceSchema.parse(payload);
          const row = await ctx.api.patch<ExecutionWorkspace>(
            `/api/execution-workspaces/${encodeURIComponent(id)}`,
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
    ws
      .command("runtime-service")
      .description(
        `Control a runtime service on an execution workspace (action: ${RUNTIME_ACTIONS.join(", ")})`,
      )
      .argument("<id>", "Execution workspace ID")
      .requiredOption("--action <action>", `One of: ${RUNTIME_ACTIONS.join(", ")}`)
      .option("--workspace-command-id <id>", "Workspace command ID")
      .option("--runtime-service-id <id>", "Existing runtime service ID")
      .option("--service-index <n>", "Configured service index")
      .action(async (id: string, opts: RuntimeControlOptions) => {
        try {
          assertRuntimeAction(opts.action);
          const ctx = resolveCommandContext(opts);
          const parsed = workspaceRuntimeControlTargetSchema.parse(
            buildRuntimeTargetPayload(opts),
          );
          const row = await ctx.api.post<unknown>(
            `/api/execution-workspaces/${encodeURIComponent(id)}/runtime-services/${encodeURIComponent(opts.action)}`,
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
    ws
      .command("runtime-command")
      .description(
        `Run a workspace command (action: ${RUNTIME_ACTIONS.join(", ")})`,
      )
      .argument("<id>", "Execution workspace ID")
      .requiredOption("--action <action>", `One of: ${RUNTIME_ACTIONS.join(", ")}`)
      .option("--workspace-command-id <id>", "Workspace command ID")
      .option("--runtime-service-id <id>", "Existing runtime service ID")
      .option("--service-index <n>", "Configured service index")
      .action(async (id: string, opts: RuntimeControlOptions) => {
        try {
          assertRuntimeAction(opts.action);
          const ctx = resolveCommandContext(opts);
          const parsed = workspaceRuntimeControlTargetSchema.parse(
            buildRuntimeTargetPayload(opts),
          );
          const row = await ctx.api.post<unknown>(
            `/api/execution-workspaces/${encodeURIComponent(id)}/runtime-commands/${encodeURIComponent(opts.action)}`,
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
