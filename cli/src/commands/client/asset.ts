import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  inferContentTypeFromPath,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AssetOptions extends BaseClientOptions {
  companyId?: string;
  file?: string;
  namespace?: string;
  alt?: string;
  title?: string;
  out?: string;
}

export function registerAssetCommands(program: Command): void {
  const asset = program.command("asset").description("Asset operations");

  addCommonClientOptions(
    asset
      .command("image:upload")
      .description("Upload a company image asset")
      .requiredOption("--file <path>", "Image file path")
      .option("-C, --company-id <id>", "Company ID")
      .option("--namespace <value>", "Asset namespace suffix")
      .option("--alt <text>", "Alt text metadata")
      .option("--title <text>", "Title metadata")
      .action(async (opts: AssetOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await uploadAsset(ctx.api.apiBase, ctx.api.apiKey, apiPath`/api/companies/${ctx.companyId}/assets/images`, opts);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    asset
      .command("logo:upload")
      .description("Upload a company logo")
      .requiredOption("--file <path>", "Logo file path")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: AssetOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const result = await uploadAsset(ctx.api.apiBase, ctx.api.apiKey, apiPath`/api/companies/${ctx.companyId}/logo`, opts);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    asset
      .command("content")
      .description("Download asset content")
      .argument("<assetId>", "Asset ID")
      .option("--out <path>", "Write content to a file instead of stdout")
      .action(async (assetId: string, opts: AssetOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const bytes = await downloadAsset(ctx.api.apiBase, ctx.api.apiKey, assetId);
          if (opts.out?.trim()) {
            await writeFile(opts.out, bytes);
            printOutput({ ok: true, out: opts.out, bytes: bytes.length }, { json: ctx.json });
            return;
          }
          process.stdout.write(bytes);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

async function uploadAsset(
  apiBase: string,
  apiKey: string | undefined,
  path: string,
  opts: AssetOptions,
): Promise<unknown> {
  if (!opts.file?.trim()) {
    throw new Error("--file is required");
  }
  const bytes = await readFile(opts.file);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: inferContentTypeFromPath(opts.file) }), opts.file.split(/[\\/]/).pop() ?? "asset");
  if (opts.namespace?.trim()) form.set("namespace", opts.namespace.trim());
  if (opts.alt?.trim()) form.set("alt", opts.alt.trim());
  if (opts.title?.trim()) form.set("title", opts.title.trim());

  const response = await fetch(buildApiUrl(apiBase, path), {
    method: "POST",
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
    body: form,
  });
  return parseFetchResponse(response);
}

async function downloadAsset(apiBase: string, apiKey: string | undefined, assetId: string): Promise<Buffer> {
  const response = await fetch(buildApiUrl(apiBase, apiPath`/api/assets/${assetId}/content`), {
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
    throw new ApiRequestError(response.status, message, undefined, parsed);
  }
  return parsed;
}

function buildApiUrl(apiBase: string, path: string): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return url.toString();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
