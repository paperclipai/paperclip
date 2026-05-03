import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  acceptIssueThreadInteractionSchema,
  cancelIssueThreadInteractionSchema,
  createChildIssueSchema,
  createIssueLabelSchema,
  createIssueThreadInteractionSchema,
  createIssueWorkProductSchema,
  linkIssueApprovalSchema,
  rejectIssueThreadInteractionSchema,
  respondIssueThreadInteractionSchema,
  restoreIssueDocumentRevisionSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  upsertIssueFeedbackVoteSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOnly extends BaseClientOptions {
  companyId?: string;
}

interface LabelCreateOptions extends CompanyOnly {
  name: string;
  color: string;
}

interface DocUpsertOptions extends BaseClientOptions {
  title?: string;
  format: string;
  body?: string;
  bodyFile?: string;
  changeSummary?: string;
  baseRevisionId?: string;
}

interface DocRevisionsOptions extends BaseClientOptions {
  limit?: string;
}

interface WorkProductCreateOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface WorkProductUpdateOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface ChildCreateOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface InteractionCreateOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface InteractionResolveOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface FeedbackVoteOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface DeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

function readJson(opts: { payload?: string; payloadFile?: string }, name: string): unknown {
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

function readBody(opts: { body?: string; bodyFile?: string }): string {
  if (opts.body !== undefined && opts.bodyFile !== undefined) {
    throw new Error("Pass either --body or --body-file, not both.");
  }
  if (opts.body !== undefined) return opts.body;
  if (opts.bodyFile !== undefined) {
    return readFileSync(opts.bodyFile, "utf8");
  }
  throw new Error("Pass --body or --body-file with the document content.");
}

async function confirmAction(message: string): Promise<boolean> {
  const { confirm } = await import("@clack/prompts");
  const answer = await confirm({ message, initialValue: false });
  return answer === true;
}

function getIssueCommand(program: Command): Command {
  const issue = program.commands.find((c) => c.name() === "issue");
  if (!issue) {
    throw new Error("issue command not registered yet; load order error");
  }
  return issue;
}

export function registerIssueExtensionCommands(program: Command): void {
  const issue = getIssueCommand(program);

  addCommonClientOptions(
    issue
      .command("delete")
      .description("Delete an issue")
      .argument("<issueId>", "Issue ID or identifier (e.g. ENG-12)")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (issueId: string, opts: DeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(`Delete issue ${issueId}?`);
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<unknown>(`/api/issues/${encodeURIComponent(issueId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("force-release")
      .description("Force-release an issue checkout (admin override)")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/admin/force-release`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("heartbeat-context")
      .description("Inspect heartbeat context for an issue (debug)")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/heartbeat-context`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("create-child")
      .description("Create a child issue under a parent")
      .argument("<parentIssueId>", "Parent issue ID")
      .option("--payload <json>", "Child issue payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (parentIssueId: string, opts: ChildCreateOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = createChildIssueSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(parentIssueId)}/children`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── read / archive markers ───────────────────────────────────────────────
  for (const verb of ["read", "inbox-archive"] as const) {
    addCommonClientOptions(
      issue
        .command(verb)
        .description(`Mark an issue as ${verb}`)
        .argument("<issueId>", "Issue ID or identifier")
        .action(async (issueId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.post<unknown>(
              `/api/issues/${encodeURIComponent(issueId)}/${verb}`,
              {},
            );
            printOutput(row, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );

    addCommonClientOptions(
      issue
        .command(`un-${verb}`)
        .description(`Reverse the ${verb} marker on an issue`)
        .argument("<issueId>", "Issue ID or identifier")
        .action(async (issueId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.delete<unknown>(
              `/api/issues/${encodeURIComponent(issueId)}/${verb}`,
            );
            printOutput(row, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );
  }

  // ── labels ──────────────────────────────────────────────────────────────
  const label = issue.command("label").description("Issue label operations");

  addCommonClientOptions(
    label
      .command("list")
      .description("List labels for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOnly) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/labels`,
          )) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const r of rows as Array<Record<string, unknown>>) {
            console.log(
              formatInlineRecord({
                id: r.id as string,
                name: r.name as string,
                color: r.color as string,
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
    label
      .command("create")
      .description("Create a new label")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Label name (max 48 chars)")
      .requiredOption("--color <hex>", "Hex color (#RRGGBB)")
      .action(async (opts: LabelCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const parsed = createIssueLabelSchema.parse({ name: opts.name, color: opts.color });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/labels`,
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
    label
      .command("delete")
      .description("Delete a label")
      .argument("<labelId>", "Label ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (labelId: string, opts: DeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(`Delete label ${labelId}?`);
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<unknown>(`/api/labels/${encodeURIComponent(labelId)}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── work products ───────────────────────────────────────────────────────
  const wp = issue.command("work-product").description("Issue work-product operations");

  addCommonClientOptions(
    wp
      .command("list")
      .description("List work products for an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/work-products`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    wp
      .command("create")
      .description("Create a work product on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .option("--payload <json>", "Work-product payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (issueId: string, opts: WorkProductCreateOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = createIssueWorkProductSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/work-products`,
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
    wp
      .command("update")
      .description("Update a work product")
      .argument("<workProductId>", "Work product ID")
      .option("--payload <json>", "Patch as JSON object")
      .option("--payload-file <path>", "Read patch from JSON file")
      .action(async (workProductId: string, opts: WorkProductUpdateOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = updateIssueWorkProductSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.patch<unknown>(
            `/api/work-products/${encodeURIComponent(workProductId)}`,
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
    wp
      .command("delete")
      .description("Delete a work product")
      .argument("<workProductId>", "Work product ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (workProductId: string, opts: DeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(`Delete work product ${workProductId}?`);
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<unknown>(
            `/api/work-products/${encodeURIComponent(workProductId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── documents ───────────────────────────────────────────────────────────
  const doc = issue.command("document").description("Issue document operations");

  addCommonClientOptions(
    doc
      .command("list")
      .description("List documents on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/documents`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    doc
      .command("get")
      .description("Get one document on an issue by key")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<key>", "Document key")
      .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    doc
      .command("upsert")
      .description("Create or update an issue document by key")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<key>", "Document key")
      .option("--title <text>", "Title (max 200 chars)")
      .requiredOption("--format <format>", "Format (markdown)")
      .option("--body <text>", "Document body")
      .option("--body-file <path>", "Read document body from file")
      .option("--change-summary <text>", "Change summary (max 500 chars)")
      .option("--base-revision-id <id>", "Base revision UUID for optimistic concurrency")
      .action(async (issueId: string, key: string, opts: DocUpsertOptions) => {
        try {
          const body = readBody(opts);
          const payload: Record<string, unknown> = {
            format: opts.format,
            body,
          };
          if (opts.title !== undefined) payload.title = opts.title;
          if (opts.changeSummary !== undefined) payload.changeSummary = opts.changeSummary;
          if (opts.baseRevisionId !== undefined) payload.baseRevisionId = opts.baseRevisionId;

          const parsed = upsertIssueDocumentSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.put<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
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
    doc
      .command("revisions")
      .description("List revisions for a document")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<key>", "Document key")
      .option("--limit <n>", "Max results")
      .action(async (issueId: string, key: string, opts: DocRevisionsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString() ? `?${params.toString()}` : "";
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions${query}`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    doc
      .command("restore-revision")
      .description("Restore a previous revision of a document")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<key>", "Document key")
      .argument("<revisionId>", "Revision ID")
      .action(async (issueId: string, key: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const parsed = restoreIssueDocumentRevisionSchema.parse({});
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore`,
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
    doc
      .command("delete")
      .description("Delete a document on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<key>", "Document key")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (issueId: string, key: string, opts: DeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(`Delete document ${key} on ${issueId}?`);
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── linked approvals ────────────────────────────────────────────────────
  const linkedApproval = issue
    .command("linked-approval")
    .description("Manage approvals linked to an issue");

  addCommonClientOptions(
    linkedApproval
      .command("list")
      .description("List approvals linked to an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/approvals`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    linkedApproval
      .command("link")
      .description("Link an existing approval to an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<approvalId>", "Approval ID")
      .action(async (issueId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const parsed = linkIssueApprovalSchema.parse({ approvalId });
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/approvals`,
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
    linkedApproval
      .command("unlink")
      .description("Unlink an approval from an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<approvalId>", "Approval ID")
      .action(async (issueId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/approvals/${encodeURIComponent(approvalId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── comments depth ──────────────────────────────────────────────────────
  addCommonClientOptions(
    issue
      .command("comments-list")
      .description("List comments on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/comments`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("comment-get")
      .description("Get a single comment by ID")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<commentId>", "Comment ID")
      .action(async (issueId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("comment-delete")
      .description("Delete a comment")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<commentId>", "Comment ID")
      .option("-y, --yes", "Skip confirmation prompt")
      .action(async (issueId: string, commentId: string, opts: DeleteOptions) => {
        try {
          if (!opts.yes && process.stdin.isTTY) {
            const ok = await confirmAction(`Delete comment ${commentId}?`);
            if (!ok) {
              console.error("Aborted.");
              process.exit(1);
            }
          }
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.delete<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── interactions ────────────────────────────────────────────────────────
  const inter = issue.command("interaction").description("Issue thread interaction operations");

  addCommonClientOptions(
    inter
      .command("list")
      .description("List interactions on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/interactions`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    inter
      .command("create")
      .description(
        "Create an interaction (kind: suggest_tasks | ask_user_questions | request_confirmation)",
      )
      .argument("<issueId>", "Issue ID or identifier")
      .option("--payload <json>", "Discriminated-union interaction payload as JSON")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (issueId: string, opts: InteractionCreateOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = createIssueThreadInteractionSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/interactions`,
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
    inter
      .command("accept")
      .description("Accept an interaction (optionally with --payload {selectedClientKeys: []})")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<interactionId>", "Interaction ID")
      .option("--payload <json>", "Optional accept payload as JSON object")
      .option("--payload-file <path>", "Read accept payload from JSON file")
      .action(async (issueId: string, interactionId: string, opts: InteractionResolveOptions) => {
        try {
          const payload = (readJson(opts, "payload") as Record<string, unknown> | undefined) ?? {};
          const parsed = acceptIssueThreadInteractionSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/accept`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  for (const verb of ["reject", "cancel"] as const) {
    addCommonClientOptions(
      inter
        .command(verb)
        .description(`${verb[0].toUpperCase()}${verb.slice(1)} an interaction`)
        .argument("<issueId>", "Issue ID or identifier")
        .argument("<interactionId>", "Interaction ID")
        .option("--reason <text>", "Reason (max 4000 chars)")
        .action(async (issueId: string, interactionId: string, opts: BaseClientOptions & { reason?: string }) => {
          try {
            const payload: Record<string, unknown> = {};
            if (opts.reason !== undefined) payload.reason = opts.reason;
            const schema = verb === "reject" ? rejectIssueThreadInteractionSchema : cancelIssueThreadInteractionSchema;
            const parsed = schema.parse(payload);
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.post<unknown>(
              `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/${verb}`,
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

  addCommonClientOptions(
    inter
      .command("respond")
      .description("Respond to an ask_user_questions interaction")
      .argument("<issueId>", "Issue ID or identifier")
      .argument("<interactionId>", "Interaction ID")
      .option("--payload <json>", "Response payload as JSON object")
      .option("--payload-file <path>", "Read response payload from JSON file")
      .action(async (issueId: string, interactionId: string, opts: InteractionResolveOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = respondIssueThreadInteractionSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── feedback votes / traces ─────────────────────────────────────────────
  const feedback = issue.command("feedback").description("Issue feedback votes and traces");

  addCommonClientOptions(
    feedback
      .command("votes")
      .description("List feedback votes on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/feedback-votes`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    feedback
      .command("vote")
      .description("Upsert a feedback vote on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .option("--payload <json>", "Vote payload as JSON")
      .option("--payload-file <path>", "Read vote payload from JSON file")
      .action(async (issueId: string, opts: FeedbackVoteOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = upsertIssueFeedbackVoteSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/issues/${encodeURIComponent(issueId)}/feedback-votes`,
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
    feedback
      .command("traces")
      .description("List feedback traces on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/feedback-traces`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    feedback
      .command("trace-get")
      .description("Get a single feedback trace by ID")
      .argument("<traceId>", "Trace ID")
      .action(async (traceId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/feedback-traces/${encodeURIComponent(traceId)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    feedback
      .command("trace-bundle")
      .description("Get a feedback trace bundle (full event tree)")
      .argument("<traceId>", "Trace ID")
      .action(async (traceId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/feedback-traces/${encodeURIComponent(traceId)}/bundle`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
