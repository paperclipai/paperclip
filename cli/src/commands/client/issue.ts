import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  cancelIssueThreadInteractionSchema,
  checkoutIssueSchema,
  createChildIssueSchema,
  createIssueLabelSchema,
  createIssueSchema,
  createIssueThreadInteractionSchema,
  createIssueTreeHoldSchema,
  createIssueWorkProductSchema,
  type FeedbackTrace,
  type HeartbeatRun,
  linkIssueApprovalSchema,
  previewIssueTreeControlSchema,
  rejectIssueThreadInteractionSchema,
  releaseIssueTreeHoldSchema,
  respondIssueThreadInteractionSchema,
  resolveIssueRecoveryActionSchema,
  restoreIssueDocumentRevisionSchema,
  updateIssueSchema,
  updateIssueWorkProductSchema,
  type Issue,
  type IssueComment,
  upsertIssueDocumentSchema,
  upsertIssueFeedbackVoteSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  inferContentTypeFromPath,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import {
  buildFeedbackTraceQuery,
  normalizeFeedbackTraceExportFormat,
  serializeFeedbackTraces,
} from "./feedback.js";

interface IssueBaseOptions extends BaseClientOptions {
  status?: string;
  assigneeAgentId?: string;
  projectId?: string;
  match?: string;
}

interface IssueCreateOptions extends BaseClientOptions {
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  requestDepth?: string;
  billingCode?: string;
}

interface IssueUpdateOptions extends BaseClientOptions {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assigneeAgentId?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  requestDepth?: string;
  billingCode?: string;
  comment?: string;
  hiddenAt?: string;
}

interface IssueCommentOptions extends BaseClientOptions {
  body: string;
  reopen?: boolean;
  resume?: boolean;
}

interface IssueCommentListOptions extends BaseClientOptions {
  afterCommentId?: string;
  order?: string;
  limit?: string;
}

interface IssueCheckoutOptions extends BaseClientOptions {
  agentId: string;
  expectedStatuses?: string;
}

interface IssueFeedbackOptions extends BaseClientOptions {
  targetType?: string;
  vote?: string;
  status?: string;
  from?: string;
  to?: string;
  sharedOnly?: boolean;
  includePayload?: boolean;
  out?: string;
  format?: string;
}

interface IssueDeleteOptions extends BaseClientOptions {
  yes?: boolean;
}

interface JsonPayloadOptions extends BaseClientOptions {
  payloadJson: string;
}

interface IssueDocumentPutOptions extends BaseClientOptions {
  title?: string;
  format?: string;
  body?: string;
  bodyFile?: string;
  changeSummary?: string;
  baseRevisionId?: string;
}

interface IssueAttachmentUploadOptions extends BaseClientOptions {
  companyId?: string;
  file: string;
  commentId?: string;
}

interface IssueAttachmentDownloadOptions extends BaseClientOptions {
  out?: string;
}

interface IssueLabelCreateOptions extends BaseClientOptions {
  companyId?: string;
  name: string;
  color: string;
}

interface IssueRecoveryResolveOptions extends BaseClientOptions {
  actionId?: string;
  outcome: string;
  sourceIssueStatus: string;
  resolutionNote?: string;
}

interface InteractionAcceptOptions extends BaseClientOptions {
  selectedClientKeys?: string;
  selectedOptionIds?: string;
}

interface InteractionReasonOptions extends BaseClientOptions {
  reason?: string;
}

interface InteractionRespondOptions extends BaseClientOptions {
  answersJson: string;
  summaryMarkdown?: string;
}

interface TreeHoldListOptions extends BaseClientOptions {
  status?: string;
  mode?: string;
  includeMembers?: boolean;
}

export function registerIssueCommands(program: Command): void {
  const issue = program.command("issue").description("Issue operations");

  addCommonClientOptions(
    issue
      .command("list")
      .description("List issues for a company")
      .option("-C, --company-id <id>", "Company ID")
      .option("--status <csv>", "Comma-separated statuses")
      .option("--assignee-agent-id <id>", "Filter by assignee agent ID")
      .option("--project-id <id>", "Filter by project ID")
      .option("--match <text>", "Local text match on identifier/title/description")
      .action(async (opts: IssueBaseOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.assigneeAgentId) params.set("assigneeAgentId", opts.assigneeAgentId);
          if (opts.projectId) params.set("projectId", opts.projectId);

          const query = params.toString();
          const path = `${apiPath`/api/companies/${ctx.companyId}/issues`}${query ? `?${query}` : ""}`;
          const rows = (await ctx.api.get<Issue[]>(path)) ?? [];

          const filtered = filterIssueRows(rows, opts.match);
          if (ctx.json) {
            printOutput(filtered, { json: true });
            return;
          }

          if (filtered.length === 0) {
            printOutput([], { json: false });
            return;
          }

          for (const item of filtered) {
            console.log(
              formatInlineRecord({
                identifier: item.identifier,
                id: item.id,
                status: item.status,
                priority: item.priority,
                assigneeAgentId: item.assigneeAgentId,
                title: item.title,
                projectId: item.projectId,
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
    issue
      .command("get")
      .description("Get an issue by UUID or identifier (e.g. PC-12)")
      .argument("<idOrIdentifier>", "Issue ID or identifier")
      .action(async (idOrIdentifier: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<Issue>(apiPath`/api/issues/${idOrIdentifier}`);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("delete")
      .description("Delete an issue")
      .argument("<issueId>", "Issue ID")
      .option("--yes", "Confirm deletion")
      .action(async (issueId: string, opts: IssueDeleteOptions) => {
        try {
          if (!opts.yes) throw new Error("Refusing to delete without --yes");
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<Issue>(apiPath`/api/issues/${issueId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("heartbeat-context")
      .description("Get heartbeat context for an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const context = await ctx.api.get(apiPath`/api/issues/${issueId}/heartbeat-context`);
          printOutput(context, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("create")
      .description("Create an issue")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--title <title>", "Issue title")
      .option("--description <text>", "Issue description")
      .option("--status <status>", "Issue status")
      .option("--priority <priority>", "Issue priority")
      .option("--assignee-agent-id <id>", "Assignee agent ID")
      .option("--project-id <id>", "Project ID")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-id <id>", "Parent issue ID")
      .option("--request-depth <n>", "Request depth integer")
      .option("--billing-code <code>", "Billing code")
      .action(async (opts: IssueCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createIssueSchema.parse({
            title: opts.title,
            description: opts.description,
            status: opts.status,
            priority: opts.priority,
            assigneeAgentId: opts.assigneeAgentId,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
            requestDepth: parseOptionalInt(opts.requestDepth),
            billingCode: opts.billingCode,
          });

          const created = await ctx.api.post<Issue>(apiPath`/api/companies/${ctx.companyId}/issues`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("update")
      .description("Update an issue")
      .argument("<issueId>", "Issue ID")
      .option("--title <title>", "Issue title")
      .option("--description <text>", "Issue description")
      .option("--status <status>", "Issue status")
      .option("--priority <priority>", "Issue priority")
      .option("--assignee-agent-id <id>", "Assignee agent ID")
      .option("--project-id <id>", "Project ID")
      .option("--goal-id <id>", "Goal ID")
      .option("--parent-id <id>", "Parent issue ID")
      .option("--request-depth <n>", "Request depth integer")
      .option("--billing-code <code>", "Billing code")
      .option("--comment <text>", "Optional comment to add with update")
      .option("--hidden-at <iso8601|null>", "Set hiddenAt timestamp or literal 'null'")
      .action(async (issueId: string, opts: IssueUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateIssueSchema.parse({
            title: opts.title,
            description: opts.description,
            status: opts.status,
            priority: opts.priority,
            assigneeAgentId: opts.assigneeAgentId,
            projectId: opts.projectId,
            goalId: opts.goalId,
            parentId: opts.parentId,
            requestDepth: parseOptionalInt(opts.requestDepth),
            billingCode: opts.billingCode,
            comment: opts.comment,
            hiddenAt: parseHiddenAt(opts.hiddenAt),
          });

          const updated = await ctx.api.patch<Issue & { comment?: IssueComment | null }>(apiPath`/api/issues/${issueId}`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment")
      .description("Add comment to issue")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--body <text>", "Comment body")
      .option("--reopen", "Reopen if issue is done/cancelled")
      .option("--resume", "Request explicit follow-up and wake the assignee when resumable")
      .action(async (issueId: string, opts: IssueCommentOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = addIssueCommentSchema.parse({
            body: opts.body,
            reopen: opts.reopen,
            resume: opts.resume,
          });
          const comment = await ctx.api.post<IssueComment>(apiPath`/api/issues/${issueId}/comments`, payload);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comments")
      .description("List issue comments")
      .argument("<issueId>", "Issue ID")
      .option("--after-comment-id <id>", "Only return comments after this comment ID")
      .option("--order <order>", "asc or desc")
      .option("--limit <n>", "Maximum comments to return")
      .action(async (issueId: string, opts: IssueCommentListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.afterCommentId) params.set("afterCommentId", opts.afterCommentId);
          if (opts.order) params.set("order", opts.order);
          if (opts.limit) params.set("limit", opts.limit);
          const query = params.toString();
          const comments = (await ctx.api.get<IssueComment[]>(
            `${apiPath`/api/issues/${issueId}/comments`}${query ? `?${query}` : ""}`,
          )) ?? [];
          printOutput(comments, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment:get")
      .description("Get one issue comment")
      .argument("<issueId>", "Issue ID")
      .argument("<commentId>", "Comment ID")
      .action(async (issueId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const comment = await ctx.api.get<IssueComment>(apiPath`/api/issues/${issueId}/comments/${commentId}`);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("comment:delete")
      .description("Delete or cancel one issue comment")
      .argument("<issueId>", "Issue ID")
      .argument("<commentId>", "Comment ID")
      .action(async (issueId: string, commentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const deleted = await ctx.api.delete<IssueComment>(apiPath`/api/issues/${issueId}/comments/${commentId}`);
          printOutput(deleted, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approvals")
      .description("List approvals linked to an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const approvals = await ctx.api.get(apiPath`/api/issues/${issueId}/approvals`);
          printOutput(approvals, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approval:link")
      .description("Link an approval to an issue")
      .argument("<issueId>", "Issue ID")
      .argument("<approvalId>", "Approval ID")
      .action(async (issueId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = linkIssueApprovalSchema.parse({ approvalId });
          const approvals = await ctx.api.post(apiPath`/api/issues/${issueId}/approvals`, payload);
          printOutput(approvals, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("approval:unlink")
      .description("Unlink an approval from an issue")
      .argument("<issueId>", "Issue ID")
      .argument("<approvalId>", "Approval ID")
      .action(async (issueId: string, approvalId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/issues/${issueId}/approvals/${approvalId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addIssuePostDeleteMarkerCommand(issue, "read", "Mark an issue as read", "post", "/read");
  addIssuePostDeleteMarkerCommand(issue, "unread", "Mark an issue as unread", "delete", "/read");
  addIssuePostDeleteMarkerCommand(issue, "archive", "Archive an issue from the inbox", "post", "/inbox-archive");
  addIssuePostDeleteMarkerCommand(issue, "unarchive", "Unarchive an issue from the inbox", "delete", "/inbox-archive");

  addCommonClientOptions(
    issue
      .command("recovery-actions")
      .description("List active recovery actions for an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get(apiPath`/api/issues/${issueId}/recovery-actions`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("recovery:resolve")
      .description("Resolve an issue recovery action")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--outcome <outcome>", "restored, false_positive, blocked, or cancelled")
      .requiredOption("--source-issue-status <status>", "todo, done, or in_review for restored outcomes; blocked is only valid for blocked outcomes")
      .option("--action-id <id>", "Specific recovery action ID")
      .option("--resolution-note <text>", "Resolution note")
      .action(async (issueId: string, opts: IssueRecoveryResolveOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = resolveIssueRecoveryActionSchema.parse({
            actionId: opts.actionId,
            outcome: opts.outcome,
            sourceIssueStatus: opts.sourceIssueStatus,
            resolutionNote: opts.resolutionNote,
          });
          const result = await ctx.api.post(apiPath`/api/issues/${issueId}/recovery-actions/resolve`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("child:create")
      .description("Create a child issue from a JSON payload")
      .argument("<issueId>", "Parent issue ID")
      .requiredOption("--payload-json <json>", "CreateChildIssue JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createChildIssueSchema.parse(parseJson(opts.payloadJson));
          const child = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/children`, payload);
          printOutput(child, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("force-release")
      .description("Force-release an issue from an agent checkout")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post(apiPath`/api/issues/${issueId}/admin/force-release`, {});
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-products")
      .description("List issue work products")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await ctx.api.get(apiPath`/api/issues/${issueId}/work-products`);
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:create")
      .description("Create an issue work product from JSON")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--payload-json <json>", "CreateIssueWorkProduct JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueWorkProductSchema.parse(parseJson(opts.payloadJson));
          const product = await ctx.api.post(apiPath`/api/issues/${issueId}/work-products`, payload);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:update")
      .description("Update a work product from JSON")
      .argument("<workProductId>", "Work product ID")
      .requiredOption("--payload-json <json>", "UpdateIssueWorkProduct JSON payload")
      .action(async (workProductId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = updateIssueWorkProductSchema.parse(parseJson(opts.payloadJson));
          const product = await ctx.api.patch(apiPath`/api/work-products/${workProductId}`, payload);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("work-product:delete")
      .description("Delete a work product")
      .argument("<workProductId>", "Work product ID")
      .action(async (workProductId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const product = await ctx.api.delete(apiPath`/api/work-products/${workProductId}`);
          printOutput(product, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("documents")
      .description("List issue documents")
      .argument("<issueId>", "Issue ID")
      .option("--include-system", "Include system documents")
      .action(async (issueId: string, opts: BaseClientOptions & { includeSystem?: boolean }) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.includeSystem ? "?includeSystem=true" : "";
          const docs = await ctx.api.get(`${apiPath`/api/issues/${issueId}/documents`}${query}`);
          printOutput(docs, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:get")
      .description("Get an issue document")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const doc = await ctx.api.get(apiPath`/api/issues/${issueId}/documents/${key}`);
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:put")
      .description("Create or update an issue document")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .option("--title <title>", "Document title")
      .option("--format <format>", "Document format", "markdown")
      .option("--body <markdown>", "Document body")
      .option("--body-file <path>", "Read document body from a file")
      .option("--change-summary <text>", "Change summary")
      .option("--base-revision-id <id>", "Expected base revision ID")
      .action(async (issueId: string, key: string, opts: IssueDocumentPutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const body = opts.bodyFile ? await readFile(opts.bodyFile, "utf8") : opts.body;
          const payload = upsertIssueDocumentSchema.parse({
            title: opts.title,
            format: opts.format,
            body,
            changeSummary: opts.changeSummary,
            baseRevisionId: opts.baseRevisionId,
          });
          const doc = await ctx.api.put(apiPath`/api/issues/${issueId}/documents/${key}`, payload);
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("interactions")
      .description("List issue thread interactions")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const interactions = await ctx.api.get(apiPath`/api/issues/${issueId}/interactions`);
          printOutput(interactions, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("interaction:create")
      .description("Create an issue thread interaction from JSON")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--payload-json <json>", "CreateIssueThreadInteraction JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueThreadInteractionSchema.parse(parseJson(opts.payloadJson));
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("interaction:accept")
      .description("Accept an issue thread interaction")
      .argument("<issueId>", "Issue ID")
      .argument("<interactionId>", "Interaction ID")
      .option("--selected-client-keys <csv>", "Client keys to accept")
      .option("--selected-option-ids <csv>", "Checkbox option IDs to accept")
      .action(async (issueId: string, interactionId: string, opts: InteractionAcceptOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = acceptIssueThreadInteractionSchema.parse({
            selectedClientKeys: opts.selectedClientKeys === undefined ? undefined : parseCsv(opts.selectedClientKeys),
            selectedOptionIds: opts.selectedOptionIds === undefined ? undefined : parseCsv(opts.selectedOptionIds),
          });
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions/${interactionId}/accept`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, action, schema, description] of [
    ["interaction:reject", "reject", rejectIssueThreadInteractionSchema, "Reject an issue thread interaction"],
    ["interaction:cancel", "cancel", cancelIssueThreadInteractionSchema, "Cancel an issue thread interaction"],
  ] as const) {
    addCommonClientOptions(
      issue
        .command(name)
        .description(description)
        .argument("<issueId>", "Issue ID")
        .argument("<interactionId>", "Interaction ID")
        .option("--reason <text>", "Reason")
        .action(async (issueId: string, interactionId: string, opts: InteractionReasonOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const payload = schema.parse({ reason: opts.reason });
            const interaction = await ctx.api.post(`${apiPath`/api/issues/${issueId}/interactions/${interactionId}`}/${action}`, payload);
            printOutput(interaction, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    issue
      .command("interaction:respond")
      .description("Respond to an issue question interaction")
      .argument("<issueId>", "Issue ID")
      .argument("<interactionId>", "Interaction ID")
      .requiredOption("--answers-json <json>", "Answers array JSON")
      .option("--summary-markdown <markdown>", "Optional response summary")
      .action(async (issueId: string, interactionId: string, opts: InteractionRespondOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = respondIssueThreadInteractionSchema.parse({
            answers: parseJson(opts.answersJson),
            summaryMarkdown: opts.summaryMarkdown,
          });
          const interaction = await ctx.api.post(apiPath`/api/issues/${issueId}/interactions/${interactionId}/respond`, payload);
          printOutput(interaction, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-state")
      .description("Get issue tree control state")
      .argument("<issueId>", "Root issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const state = await ctx.api.get(apiPath`/api/issues/${issueId}/tree-control/state`);
          printOutput(state, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-preview")
      .description("Preview issue tree control changes")
      .argument("<issueId>", "Root issue ID")
      .requiredOption("--payload-json <json>", "PreviewIssueTreeControl JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = previewIssueTreeControlSchema.parse(parseJson(opts.payloadJson));
          const preview = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-control/preview`, payload);
          printOutput(preview, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-holds")
      .description("List issue tree holds")
      .argument("<issueId>", "Root issue ID")
      .option("--status <status>", "active or released")
      .option("--mode <mode>", "pause, resume, cancel, or restore")
      .option("--include-members", "Include hold members")
      .action(async (issueId: string, opts: TreeHoldListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const params = new URLSearchParams();
          if (opts.status) params.set("status", opts.status);
          if (opts.mode) params.set("mode", opts.mode);
          if (opts.includeMembers) params.set("includeMembers", "true");
          const query = params.toString();
          const holds = await ctx.api.get(`${apiPath`/api/issues/${issueId}/tree-holds`}${query ? `?${query}` : ""}`);
          printOutput(holds, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:create")
      .description("Create an issue tree hold from JSON")
      .argument("<issueId>", "Root issue ID")
      .requiredOption("--payload-json <json>", "CreateIssueTreeHold JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = createIssueTreeHoldSchema.parse(parseJson(opts.payloadJson));
          const hold = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-holds`, payload);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:get")
      .description("Get an issue tree hold")
      .argument("<issueId>", "Root issue ID")
      .argument("<holdId>", "Hold ID")
      .action(async (issueId: string, holdId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const hold = await ctx.api.get(apiPath`/api/issues/${issueId}/tree-holds/${holdId}`);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("tree-hold:release")
      .description("Release an issue tree hold")
      .argument("<issueId>", "Root issue ID")
      .argument("<holdId>", "Hold ID")
      .option("--payload-json <json>", "ReleaseIssueTreeHold JSON payload", "{}")
      .action(async (issueId: string, holdId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = releaseIssueTreeHoldSchema.parse(parseJson(opts.payloadJson));
          const hold = await ctx.api.post(apiPath`/api/issues/${issueId}/tree-holds/${holdId}/release`, payload);
          printOutput(hold, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachments")
      .description("List issue attachments")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const attachments = await ctx.api.get(apiPath`/api/issues/${issueId}/attachments`);
          printOutput(attachments, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachment:upload")
      .description("Upload an issue attachment")
      .argument("<issueId>", "Issue ID")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--file <path>", "File to upload")
      .option("--comment-id <id>", "Attach to an issue comment")
      .action(async (issueId: string, opts: IssueAttachmentUploadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const attachment = await uploadAttachment(ctx.api.apiBase, ctx.api.apiKey, {
            companyId: ctx.companyId ?? "",
            issueId,
            filePath: opts.file,
            commentId: opts.commentId,
            runId: ctx.api.runId,
          });
          printOutput(attachment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("attachment:download")
      .description("Download an attachment")
      .argument("<attachmentId>", "Attachment ID")
      .option("--out <path>", "Output file path; prints to stdout when omitted")
      .action(async (attachmentId: string, opts: IssueAttachmentDownloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const bytes = await downloadAttachment(ctx.api.apiBase, ctx.api.apiKey, attachmentId);
          if (opts.out) {
            await writeFile(opts.out, bytes);
            if (ctx.json) printOutput({ out: opts.out, bytes: bytes.byteLength }, { json: true });
            else console.log(`Wrote ${bytes.byteLength} byte(s) to ${opts.out}`);
            return;
          }
          process.stdout.write(bytes);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("attachment:delete")
      .description("Delete an attachment")
      .argument("<attachmentId>", "Attachment ID")
      .action(async (attachmentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/attachments/${attachmentId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("label:list")
      .description("List issue labels in a company")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const labels = await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/labels`);
          printOutput(labels, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("label:create")
      .description("Create an issue label")
      .option("-C, --company-id <id>", "Company ID")
      .requiredOption("--name <name>", "Label name")
      .requiredOption("--color <hex>", "Label color, e.g. #4f46e5")
      .action(async (opts: IssueLabelCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const payload = createIssueLabelSchema.parse({ name: opts.name, color: opts.color });
          const label = await ctx.api.post(apiPath`/api/companies/${ctx.companyId}/labels`, payload);
          printOutput(label, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("label:delete")
      .description("Delete an issue label")
      .argument("<labelId>", "Label ID")
      .action(async (labelId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete(apiPath`/api/labels/${labelId}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:votes")
      .description("List feedback votes for an issue")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const votes = await ctx.api.get(apiPath`/api/issues/${issueId}/feedback-votes`);
          printOutput(votes, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:vote")
      .description("Create or update a feedback vote")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--payload-json <json>", "UpsertIssueFeedbackVote JSON payload")
      .action(async (issueId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = upsertIssueFeedbackVoteSchema.parse(parseJson(opts.payloadJson));
          const vote = await ctx.api.post(apiPath`/api/issues/${issueId}/feedback-votes`, payload);
          printOutput(vote, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  for (const [name, pathSuffix, description] of [
    ["document:delete", "", "Delete an issue document"],
    ["document:lock", "/lock", "Lock an issue document"],
    ["document:unlock", "/unlock", "Unlock an issue document"],
  ] as const) {
    addCommonClientOptions(
      issue
        .command(name)
        .description(description)
        .argument("<issueId>", "Issue ID")
        .argument("<key>", "Document key")
        .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const path = `${apiPath`/api/issues/${issueId}/documents/${key}`}${pathSuffix}`;
            const result = name === "document:delete" ? await ctx.api.delete(path) : await ctx.api.post(path, {});
            printOutput(result, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
    );
  }

  addCommonClientOptions(
    issue
      .command("document:revisions")
      .description("List issue document revisions")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .action(async (issueId: string, key: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const revisions = await ctx.api.get(apiPath`/api/issues/${issueId}/documents/${key}/revisions`);
          printOutput(revisions, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("document:restore")
      .description("Restore an issue document revision")
      .argument("<issueId>", "Issue ID")
      .argument("<key>", "Document key")
      .argument("<revisionId>", "Revision ID")
      .action(async (issueId: string, key: string, revisionId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = restoreIssueDocumentRevisionSchema.parse({});
          const doc = await ctx.api.post(
            apiPath`/api/issues/${issueId}/documents/${key}/revisions/${revisionId}/restore`,
            payload,
          );
          printOutput(doc, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:list")
      .description("List feedback traces for an issue")
      .argument("<issueId>", "Issue ID")
      .option("--target-type <type>", "Filter by target type")
      .option("--vote <vote>", "Filter by vote value")
      .option("--status <status>", "Filter by trace status")
      .option("--from <iso8601>", "Only include traces created at or after this timestamp")
      .option("--to <iso8601>", "Only include traces created at or before this timestamp")
      .option("--shared-only", "Only include traces eligible for sharing/export")
      .option("--include-payload", "Include stored payload snapshots in the response")
      .action(async (issueId: string, opts: IssueFeedbackOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const traces = (await ctx.api.get<FeedbackTrace[]>(
            `${apiPath`/api/issues/${issueId}/feedback-traces`}${buildFeedbackTraceQuery(opts)}`,
          )) ?? [];
          if (ctx.json) {
            printOutput(traces, { json: true });
            return;
          }
          printOutput(
            traces.map((trace) => ({
              id: trace.id,
              issue: trace.issueIdentifier ?? trace.issueId,
              vote: trace.vote,
              status: trace.status,
              targetType: trace.targetType,
              target: trace.targetSummary.label,
            })),
            { json: false },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("runs")
      .description("List heartbeat runs associated with an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>(apiPath`/api/issues/${issueId}/runs`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("live-runs")
      .description("List queued and running heartbeat runs associated with an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<HeartbeatRun[]>(apiPath`/api/issues/${issueId}/live-runs`)) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("active-run")
      .description("Show the active heartbeat run associated with an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const run = await ctx.api.get<HeartbeatRun | null>(apiPath`/api/issues/${issueId}/active-run`);
          printOutput(run, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("feedback:export")
      .description("Export feedback traces for an issue")
      .argument("<issueId>", "Issue ID")
      .option("--target-type <type>", "Filter by target type")
      .option("--vote <vote>", "Filter by vote value")
      .option("--status <status>", "Filter by trace status")
      .option("--from <iso8601>", "Only include traces created at or after this timestamp")
      .option("--to <iso8601>", "Only include traces created at or before this timestamp")
      .option("--shared-only", "Only include traces eligible for sharing/export")
      .option("--include-payload", "Include stored payload snapshots in the export")
      .option("--out <path>", "Write export to a file path instead of stdout")
      .option("--format <format>", "Export format: json or ndjson", "ndjson")
      .action(async (issueId: string, opts: IssueFeedbackOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const traces = (await ctx.api.get<FeedbackTrace[]>(
            `${apiPath`/api/issues/${issueId}/feedback-traces`}${buildFeedbackTraceQuery(opts, opts.includePayload ?? true)}`,
          )) ?? [];
            const serialized = serializeFeedbackTraces(traces, opts.format);
            if (opts.out?.trim()) {
              await writeFile(opts.out, serialized, "utf8");
              if (ctx.json) {
                printOutput(
                  { out: opts.out, count: traces.length, format: normalizeFeedbackTraceExportFormat(opts.format) },
                  { json: true },
                );
                return;
              }
              console.log(`Wrote ${traces.length} feedback trace(s) to ${opts.out}`);
            return;
          }
          process.stdout.write(`${serialized}${serialized.endsWith("\n") ? "" : "\n"}`);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("checkout")
      .description("Checkout issue for an agent")
      .argument("<issueId>", "Issue ID")
      .requiredOption("--agent-id <id>", "Agent ID")
      .option(
        "--expected-statuses <csv>",
        "Expected current statuses",
        "todo,backlog,blocked",
      )
      .action(async (issueId: string, opts: IssueCheckoutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = checkoutIssueSchema.parse({
            agentId: opts.agentId,
            expectedStatuses: parseCsv(opts.expectedStatuses),
          });
          const updated = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/checkout`, payload);
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("release")
      .description("Release issue back to todo and clear assignee")
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const updated = await ctx.api.post<Issue>(apiPath`/api/issues/${issueId}/release`, {});
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function addIssuePostDeleteMarkerCommand(
  issue: Command,
  name: string,
  description: string,
  method: "post" | "delete",
  pathSuffix: string,
): void {
  addCommonClientOptions(
    issue
      .command(name)
      .description(description)
      .argument("<issueId>", "Issue ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = method === "post"
            ? await ctx.api.post(`${apiPath`/api/issues/${issueId}`}${pathSuffix}`, {})
            : await ctx.api.delete(`${apiPath`/api/issues/${issueId}`}${pathSuffix}`);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function parseHiddenAt(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "null") return null;
  return value;
}

function filterIssueRows(rows: Issue[], match: string | undefined): Issue[] {
  if (!match?.trim()) return rows;
  const needle = match.trim().toLowerCase();
  return rows.filter((row) => {
    const text = [row.identifier, row.title, row.description]
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .toLowerCase();
    return text.includes(needle);
  });
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

async function uploadAttachment(
  apiBase: string,
  apiKey: string | undefined,
  input: { companyId: string; issueId: string; filePath: string; commentId?: string; runId?: string },
): Promise<unknown> {
  const bytes = await readFile(input.filePath);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: inferContentTypeFromPath(input.filePath) }), input.filePath.split(/[\\/]/).pop() ?? "attachment");
  if (input.commentId) form.set("issueCommentId", input.commentId);
  // This multipart upload uses a hand-rolled fetch rather than PaperclipApiClient,
  // so it must forward the agent run-id header itself — otherwise an
  // agent-authenticated upload is rejected with "401 Agent run id required"
  // (the client injects x-paperclip-run-id automatically for JSON requests).
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (input.runId) headers["x-paperclip-run-id"] = input.runId;
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/companies/${input.companyId}/issues/${input.issueId}/attachments`), {
    method: "POST",
    headers,
    body: form,
  });
  return parseFetchResponse(response);
}

async function downloadAttachment(
  apiBase: string,
  apiKey: string | undefined,
  attachmentId: string,
): Promise<Buffer> {
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/attachments/${attachmentId}/content`), {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) {
    await parseFetchResponse(response);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function parseFetchResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text.trim() ? safeJson(text) : null;
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `Request failed with status ${response.status}`;
    throw new Error(`API error ${response.status}: ${message}`);
  }
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
