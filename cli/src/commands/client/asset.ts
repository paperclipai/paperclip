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

interface ImageUploadOptions extends BaseClientOptions {
  companyId?: string;
  file: string;
  namespace?: string;
}

interface LogoUploadOptions extends BaseClientOptions {
  companyId?: string;
  file: string;
}

interface ContentDownloadOptions extends BaseClientOptions {
  output?: string;
}

const SUPPORTED_IMAGE_TYPES = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
]);

function inferMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_IMAGE_TYPES.get(ext) ?? "application/octet-stream";
}

async function loadFileAsBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  await stat(path);
  const buf = await readFile(path);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const blob = new Blob([arrayBuffer], { type: inferMimeType(path) });
  return { blob, filename: basename(path) };
}

export function registerAssetCommands(program: Command): void {
  const asset = program
    .command("asset")
    .description("Asset upload and content download");

  addCommonClientOptions(
    asset
      .command("upload-image")
      .description("Upload an image asset to a company namespace")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--file <path>", "Path to local image file")
      .option("--namespace <name>", "Namespace suffix (default: general)")
      .action(async (opts: ImageUploadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const { blob, filename } = await loadFileAsBlob(opts.file);
          const form = new FormData();
          form.append("file", blob, filename);
          if (opts.namespace !== undefined) form.append("namespace", opts.namespace);
          const row = await ctx.api.postMultipart<unknown>(
            `/api/companies/${ctx.companyId}/assets/images`,
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
    asset
      .command("upload-logo")
      .description("Upload a company logo")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--file <path>", "Path to local logo file")
      .action(async (opts: LogoUploadOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const { blob, filename } = await loadFileAsBlob(opts.file);
          const form = new FormData();
          form.append("file", blob, filename);
          const row = await ctx.api.postMultipart<unknown>(
            `/api/companies/${ctx.companyId}/logo`,
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
    asset
      .command("download")
      .description("Download asset content (writes to --output or stdout)")
      .argument("<assetId>", "Asset ID")
      .option("--output <path>", "Output file path (omit to write to stdout)")
      .action(async (assetId: string, opts: ContentDownloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const { body } = await ctx.api.getStream(
            `/api/assets/${encodeURIComponent(assetId)}/content`,
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
}
