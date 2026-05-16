import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  createIssueTreeHoldSchema,
  previewIssueTreeControlSchema,
  releaseIssueTreeHoldSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface PayloadOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface HoldsListOptions extends BaseClientOptions {
  status?: string;
  mode?: string;
  includeMembers?: boolean;
}

function readJson(opts: PayloadOptions, name: string): unknown {
  if (opts.payload !== undefined && opts.payloadFile !== undefined) {
    throw new Error(`Pass either --${name} or --${name}-file, not both.`);
  }
  if (opts.payload !== undefined) {
    try {
      return JSON.parse(opts.payload);
    } catch (err) {
      throw new Error(`--${name} must be valid JSON: ${(err as Error).message}`);
    }
  }
  if (opts.payloadFile !== undefined) {
    const raw = readFileSync(opts.payloadFile, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`--${name}-file must be valid JSON: ${(err as Error).message}`);
    }
  }
  return undefined;
}

export function registerIssueTreeControlCommands(program: Command): void {
  const tree = program
    .command("issue-tree")
    .description("Issue tree control: pause/resume/cancel/restore subtrees");

  addCommonClientOptions(
    tree
      .command("preview")
      .description("Preview a tree-control operation against a root issue")
      .argument("<rootIssueId>", "Root issue ID or identifier")
      .option("--payload <json>", "Preview request payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (rootIssueId: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = previewIssueTreeControlSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(rootIssueId)}/tree-control/preview`,
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
    tree
      .command("state")
      .description("Get the active pause-hold gate for an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/tree-control/state`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const hold = tree.command("hold").description("Tree hold operations");

  addCommonClientOptions(
    hold
      .command("create")
      .description("Create a new tree hold (pause/resume/cancel/restore)")
      .argument("<rootIssueId>", "Root issue ID or identifier")
      .option("--payload <json>", "Hold payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (rootIssueId: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = createIssueTreeHoldSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(rootIssueId)}/tree-holds`,
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
    hold
      .command("list")
      .description("List tree holds for a root issue")
      .argument("<rootIssueId>", "Root issue ID or identifier")
      .option("--status <status>", "Filter by status (active, released)")
      .option("--mode <mode>", "Filter by mode (pause, resume, cancel, restore)")
      .option("--include-members", "Include hold members")
      .action(async (rootIssueId: string, opts: HoldsListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.mode) params.set("mode", opts.mode);
          if (opts.includeMembers) params.set("includeMembers", "true");
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(rootIssueId)}/tree-holds${query}`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    hold
      .command("get")
      .description("Get a single tree hold")
      .argument("<rootIssueId>", "Root issue ID or identifier")
      .argument("<holdId>", "Hold ID")
      .action(async (rootIssueId: string, holdId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/issues/${encodeURIComponent(rootIssueId)}/tree-holds/${encodeURIComponent(holdId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    hold
      .command("release")
      .description("Release an active tree hold")
      .argument("<rootIssueId>", "Root issue ID or identifier")
      .argument("<holdId>", "Hold ID")
      .option("--payload <json>", "Release payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (rootIssueId: string, holdId: string, opts: PayloadOptions) => {
        try {
          const payload = (readJson(opts, "payload") as Record<string, unknown> | undefined) ?? {};
          const parsed = releaseIssueTreeHoldSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(rootIssueId)}/tree-holds/${encodeURIComponent(holdId)}/release`,
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
