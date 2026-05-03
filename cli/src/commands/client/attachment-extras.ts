import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Command } from "commander";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOnly extends BaseClientOptions {
  companyId?: string;
}

interface AttachmentUploadOptions extends CompanyOnly {
  file: string;
  contentType?: string;
}

interface AttachmentDownloadOptions extends BaseClientOptions {
  output?: string;
}

const MIME_BY_EXT = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["json", "application/json"],
  ["md", "text/markdown"],
]);

function inferMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT.get(ext) ?? "application/octet-stream";
}

async function loadFileAsBlob(path: string, contentType?: string): Promise<{ blob: Blob; filename: string }> {
  await stat(path);
  const buf = await readFile(path);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const blob = new Blob([arrayBuffer], { type: contentType ?? inferMimeType(path) });
  return { blob, filename: basename(path) };
}

function getIssueCommand(program: Command): Command {
  const issue = program.commands.find((c) => c.name() === "issue");
  if (!issue) throw new Error("issue command not registered yet; load order error");
  return issue;
}

export function registerAttachmentExtensionCommands(program: Command): void {
  const issue = getIssueCommand(program);

  addCommonClientOptions(
    issue
      .command("attachment-list")
      .description("List attachments on an issue")
      .argument("<issueId>", "Issue ID or identifier")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = await ctx.api.get<unknown[]>(
            `/api/issues/${encodeURIComponent(issueId)}/attachments`,
          );
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("attachment-upload")
      .description("Upload a file as an issue attachment")
      .argument("<issueId>", "Issue ID")
      .requiredOption("-C, --company-id <id>", "Company ID owning the issue")
      .requiredOption("--file <path>", "Path to local file")
      .option("--content-type <mime>", "Override inferred MIME type")
      .action(async (issueId: string, opts: AttachmentUploadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const { blob, filename } = await loadFileAsBlob(opts.file, opts.contentType);
          const form = new FormData();
          form.append("file", blob, filename);
          const row = await ctx.api.postMultipart<unknown>(
            `/api/companies/${ctx.companyId}/issues/${encodeURIComponent(issueId)}/attachments`,
            form,
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
      .command("attachment-download")
      .description("Download an attachment's content (writes to --output or stdout)")
      .argument("<attachmentId>", "Attachment ID")
      .option("--output <path>", "Output file path (omit to write to stdout)")
      .action(async (attachmentId: string, opts: AttachmentDownloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const { body } = await ctx.api.getStream(
            `/api/attachments/${encodeURIComponent(attachmentId)}/content`,
          );
          const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
          if (opts.output) {
            await pipeline(nodeStream, createWriteStream(opts.output));
            console.error(`wrote ${opts.output}`);
          } else {
            await pipeline(nodeStream, process.stdout);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    issue
      .command("attachment-delete")
      .description("Delete an issue attachment")
      .argument("<attachmentId>", "Attachment ID")
      .action(async (attachmentId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          await ctx.api.delete(
            `/api/attachments/${encodeURIComponent(attachmentId)}`,
          );
          printOutput({ ok: true, attachmentId }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
