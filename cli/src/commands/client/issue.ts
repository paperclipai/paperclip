import { Command } from "commander";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  addIssueCommentSchema,
  checkoutIssueSchema,
  createIssueSchema,
  createIssueWorkProductSchema,
  type FeedbackTrace,
  updateIssueSchema,
  upsertIssueDocumentSchema,
  type Issue,
  type IssueAttachment,
  type IssueComment,
  type IssueDocument,
  type IssueWorkProduct,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
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

interface IssueEvidencePublishOptions extends BaseClientOptions {
  prUrl: string;
  commitSha?: string;
  changedFile?: string[];
  check?: string[];
  screenshot?: string[];
  log?: string[];
  risk?: string[];
  summary?: string;
  workerLog?: string;
}

interface EvidenceAttachmentInput {
  kind: "screenshot" | "log";
  path: string;
}

interface EvidenceAttachmentSummary {
  id: string;
  originalFilename: string | null;
  contentPath: string;
  contentType: string;
  byteSize: number;
  kind: "screenshot" | "log";
}

interface EvidencePacketInput {
  issue: Issue;
  prUrl: string;
  commitSha: string;
  changedFiles: string[];
  checks: string[];
  screenshots: EvidenceAttachmentSummary[];
  logs: EvidenceAttachmentSummary[];
  residualRisks: string[];
  diffSummary?: string | null;
  workerLog?: string | null;
}

interface PublishedEvidencePacket {
  document: IssueDocument;
  workProduct: IssueWorkProduct | null;
  comment: IssueComment | null;
  attachments: EvidenceAttachmentSummary[];
}

const execFileAsync = promisify(execFile);
const QA_EVIDENCE_PACKET_DOCUMENT_KEY = "qa-evidence-packet";

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
          const path = `/api/companies/${ctx.companyId}/issues${query ? `?${query}` : ""}`;
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
          const row = await ctx.api.get<Issue>(`/api/issues/${idOrIdentifier}`);
          printOutput(row, { json: ctx.json });
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

          const created = await ctx.api.post<Issue>(`/api/companies/${ctx.companyId}/issues`, payload);
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

          const updated = await ctx.api.patch<Issue & { comment?: IssueComment | null }>(`/api/issues/${issueId}`, payload);
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
          const comment = await ctx.api.post<IssueComment>(`/api/issues/${issueId}/comments`, payload);
          printOutput(comment, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    issue
      .command("evidence:publish")
      .description("Publish a QA evidence packet document, attachments, PR work product, and issue comment")
      .argument("<issueId>", "Issue ID or identifier")
      .requiredOption("--pr-url <url>", "Pull request URL")
      .option("--commit-sha <sha>", "Commit SHA (defaults to HEAD)")
      .option("--changed-file <path...>", "Changed file path; repeat or pass multiple values")
      .option("--check <text...>", "Exact verification command/output line; repeat or pass multiple values")
      .option("--screenshot <path...>", "Screenshot file to upload; repeat or pass multiple values")
      .option("--log <path...>", "Log file to upload; repeat or pass multiple values")
      .option("--risk <text...>", "Residual risk line; repeat or pass multiple values")
      .option("--summary <text>", "Diff summary override (defaults to changed-file list)")
      .option("--worker-log <text>", "Short worker log excerpt to include in the packet")
      .action(async (issueId: string, opts: IssueEvidencePublishOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const issueRow = await ctx.api.get<Issue>(`/api/issues/${issueId}`);
          if (!issueRow) throw new Error("Issue not found");
          const commitSha = opts.commitSha?.trim() || await gitOutput(["rev-parse", "HEAD"]);
          const changedFiles = normalizeList(opts.changedFile);
          const effectiveChangedFiles = changedFiles.length > 0
            ? changedFiles
            : await gitChangedFiles();
          const checks = normalizeList(opts.check);
          const risks = normalizeList(opts.risk);
          const attachmentInputs = [
            ...normalizeList(opts.screenshot).map((filePath) => ({ kind: "screenshot" as const, path: filePath })),
            ...normalizeList(opts.log).map((filePath) => ({ kind: "log" as const, path: filePath })),
          ];

          const attachments: EvidenceAttachmentSummary[] = [];
          for (const attachment of attachmentInputs) {
            attachments.push(await uploadEvidenceAttachment(ctx.api, issueRow, attachment));
          }

          const packetBody = renderQaEvidencePacket({
            issue: issueRow,
            prUrl: opts.prUrl,
            commitSha,
            changedFiles: effectiveChangedFiles,
            checks,
            screenshots: attachments.filter((attachment) => attachment.kind === "screenshot"),
            logs: attachments.filter((attachment) => attachment.kind === "log"),
            residualRisks: risks,
            diffSummary: opts.summary ?? null,
            workerLog: opts.workerLog ?? null,
          });

          const existingPacket = await ctx.api.get<IssueDocument>(
            `/api/issues/${issueRow.id}/documents/${QA_EVIDENCE_PACKET_DOCUMENT_KEY}`,
            { ignoreNotFound: true },
          );
          const documentPayload = upsertIssueDocumentSchema.parse({
            title: "QA Evidence Packet",
            format: "markdown",
            body: packetBody,
            changeSummary: "Publish QA evidence packet",
            baseRevisionId: existingPacket?.latestRevisionId ?? null,
          });
          const document = await ctx.api.put<IssueDocument>(
            `/api/issues/${issueRow.id}/documents/${QA_EVIDENCE_PACKET_DOCUMENT_KEY}`,
            documentPayload,
          );
          if (!document) throw new Error("Paperclip did not return the evidence document");

          const workProductPayload = createIssueWorkProductSchema.parse({
            type: "pull_request",
            provider: "github",
            externalId: opts.prUrl,
            title: `PR evidence for ${issueRow.identifier ?? issueRow.id}`,
            url: opts.prUrl,
            status: "ready_for_review",
            reviewState: "needs_board_review",
            isPrimary: true,
            summary: `QA evidence packet ${QA_EVIDENCE_PACKET_DOCUMENT_KEY} r${document.latestRevisionNumber}`,
            metadata: {
              evidencePacketDocumentKey: document.key,
              evidencePacketRevisionId: document.latestRevisionId,
              evidencePacketRevisionNumber: document.latestRevisionNumber,
              commitSha,
              attachmentIds: attachments.map((attachment) => attachment.id),
            },
          });
          const workProduct = await ctx.api.post<IssueWorkProduct>(
            `/api/issues/${issueRow.id}/work-products`,
            workProductPayload,
          );

          const commentBody = renderQaEvidencePacketComment(document, attachments, workProduct);
          const comment = await ctx.api.post<IssueComment>(
            `/api/issues/${issueRow.id}/comments`,
            addIssueCommentSchema.parse({ body: commentBody }),
          );

          const result: PublishedEvidencePacket = {
            document,
            workProduct,
            comment,
            attachments,
          };
          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }
          console.log(`Published QA evidence packet: issue=${issueRow.identifier ?? issueRow.id} document=${document.key} revision=${document.latestRevisionNumber} revisionId=${document.latestRevisionId}`);
          console.log(`Attachments: ${attachments.length === 0 ? "(none)" : attachments.map((attachment) => `${attachment.id}:${attachment.contentPath}`).join(", ")}`);
          if (workProduct) console.log(`PR work product: ${workProduct.id}`);
          if (comment) console.log(`Comment: ${comment.id}`);
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
            `/api/issues/${issueId}/feedback-traces${buildFeedbackTraceQuery(opts)}`,
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
            `/api/issues/${issueId}/feedback-traces${buildFeedbackTraceQuery(opts, opts.includePayload ?? true)}`,
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
          const updated = await ctx.api.post<Issue>(`/api/issues/${issueId}/checkout`, payload);
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
          const updated = await ctx.api.post<Issue>(`/api/issues/${issueId}/release`, {});
          printOutput(updated, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

export function renderQaEvidencePacket(input: EvidencePacketInput): string {
  const issueLabel = input.issue.identifier ?? input.issue.id;
  const diffSummary = input.diffSummary?.trim() || (
    input.changedFiles.length > 0
      ? `${input.changedFiles.length} changed file(s): ${input.changedFiles.join(", ")}`
      : "No changed files were provided or detected."
  );
  const workerLog = input.workerLog?.trim();
  const logExcerpt = workerLog || (
    input.logs.length > 0
      ? "See attached log artifact(s)."
      : "No log excerpt or log attachment was provided."
  );

  return [
    "# QA Evidence Packet",
    "",
    `Issue: ${issueLabel}`,
    `PR URL: ${input.prUrl}`,
    `Commit SHA: ${input.commitSha}`,
    "",
    "## Diff Summary",
    "",
    diffSummary,
    "",
    "## Changed Files",
    "",
    renderBulletList(input.changedFiles, "No changed files were provided or detected."),
    "",
    "## Checks And Output",
    "",
    renderBulletList(input.checks, "No checks were provided."),
    "",
    "## Screenshot Artifacts",
    "",
    renderAttachmentList(input.screenshots, "No screenshot artifacts were attached."),
    "",
    "## Log Evidence",
    "",
    logExcerpt,
    "",
    renderAttachmentList(input.logs, "No log artifacts were attached."),
    "",
    "## Residual Risks",
    "",
    renderBulletList(input.residualRisks, "None reported."),
    "",
  ].join("\n");
}

export function renderQaEvidencePacketComment(
  document: IssueDocument,
  attachments: EvidenceAttachmentSummary[],
  workProduct: IssueWorkProduct | null,
): string {
  const attachmentSummary = attachments.length > 0
    ? attachments.map((attachment) => `${attachment.id} (${attachment.contentPath})`).join(", ")
    : "none";
  return [
    `QA evidence packet published: document \`${document.key}\` revision ${document.latestRevisionNumber} (${document.latestRevisionId}).`,
    `Attachments: ${attachmentSummary}.`,
    workProduct ? `PR work product: ${workProduct.id}.` : "PR work product: not created.",
  ].join("\n");
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
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

function normalizeList(value: string[] | string | undefined): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => item.trim()).filter(Boolean);
}

function renderBulletList(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((item) => `- ${item}`).join("\n");
}

function renderAttachmentList(items: EvidenceAttachmentSummary[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((item) => `- ${item.originalFilename ?? item.id}: ${item.contentPath} (${item.id})`).join("\n");
}

async function gitOutput(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: process.cwd() });
  return stdout.trim();
}

async function gitChangedFiles(): Promise<string[]> {
  const mergeBase = await gitOutput(["merge-base", "HEAD", "master"]).catch(() => "");
  const args = mergeBase ? ["diff", "--name-only", mergeBase, "HEAD"] : ["diff", "--name-only", "HEAD~1", "HEAD"];
  return (await gitOutput(args).catch(() => ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function uploadEvidenceAttachment(
  api: { postForm<T>(path: string, body: FormData): Promise<T | null> },
  issue: Issue,
  input: EvidenceAttachmentInput,
): Promise<EvidenceAttachmentSummary> {
  const filePath = path.resolve(input.path);
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Attachment path is not a file: ${input.path}`);
  const bytes = await readFile(filePath);
  const filename = path.basename(filePath);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: inferContentType(filename) }), filename);
  const attachment = await api.postForm<IssueAttachment>(
    `/api/companies/${issue.companyId}/issues/${issue.id}/attachments`,
    form,
  );
  if (!attachment) throw new Error(`Paperclip did not return attachment metadata for ${input.path}`);
  return {
    id: attachment.id,
    originalFilename: attachment.originalFilename,
    contentPath: attachment.contentPath,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    kind: input.kind,
  };
}

function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".html") return "text/html";
  if (ext === ".json") return "application/json";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  return "application/octet-stream";
}
