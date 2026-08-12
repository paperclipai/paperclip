import { basename } from "node:path";
import type { Readable } from "node:stream";
import { unprocessable } from "../errors.js";

export const PAPERCLIP_IMAGE_MODEL = "gpt-image-2";

const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_IMAGE_GENERATION_URL = "https://api.openai.com/v1/images/generations";

type GenerationMode = "prompt_only" | "reference_backed";

export interface ImageReferenceInput {
  /**
   * Backwards-compatible binding id. For attachment inputs this is the
   * attachment id; for inline asset inputs it is the asset id.
   */
  attachmentId: string;
  sourceKind?: "attachment" | "asset";
  sourceId?: string;
  assetId?: string | null;
  sha256?: string | null;
  filename: string | null;
  contentType: string;
  bytes: Buffer;
}

export interface GenerateOpenAiImageInput {
  prompt: string;
  size: string;
  quality: string;
  references: ImageReferenceInput[];
  apiKey?: string | null;
  /** When false, an absent override must not silently fall through to an
   * instance-wide key. Managed agent credential assignments use this mode. */
  allowEnvironmentFallback?: boolean;
  fetchImpl?: typeof fetch;
}

export interface GenerateOpenAiImageResult {
  model: typeof PAPERCLIP_IMAGE_MODEL;
  endpoint: string;
  generationMode: GenerationMode;
  actualImageInputsBound: string[];
  outputBytes: Buffer;
  outputContentType: "image/png";
  providerRequestId: string | null;
}

export function imageReferenceSourceId(reference: ImageReferenceInput) {
  return reference.sourceId?.trim() || reference.attachmentId;
}

type OpenAiImageResponse = {
  data?: Array<{
    b64_json?: unknown;
    url?: unknown;
  }>;
  error?: {
    message?: unknown;
    code?: unknown;
    type?: unknown;
  };
};

export type OpenAiImageCredentialFailureKind = "quota" | "rate_limit" | "auth";

/** Structured provider failure retained for credential-circuit attribution. */
export class OpenAiImageProviderError extends Error {
  readonly statusCode: number;
  readonly providerErrorCode: string | null;
  readonly providerRequestId: string | null;
  readonly retryNotBefore: Date | null;
  readonly credentialFailureKind: OpenAiImageCredentialFailureKind | null;

  constructor(input: {
    message: string;
    statusCode: number;
    providerErrorCode: string | null;
    providerRequestId?: string | null;
    retryNotBefore: Date | null;
    credentialFailureKind: OpenAiImageCredentialFailureKind | null;
  }) {
    super(input.message);
    this.name = "OpenAiImageProviderError";
    this.statusCode = input.statusCode;
    this.providerErrorCode = input.providerErrorCode;
    this.providerRequestId = input.providerRequestId ?? null;
    this.retryNotBefore = input.retryNotBefore;
    this.credentialFailureKind = input.credentialFailureKind;
  }
}

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function resolveOpenAiImageApiKey(
  apiKeyOverride?: string | null,
  allowEnvironmentFallback = true,
): string {
  const apiKey =
    apiKeyOverride?.trim() ||
    (allowEnvironmentFallback
      ? process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
      : "");
  if (!apiKey) {
    throw unprocessable(
      "Image generation is not available in this Paperclip runtime. Codex subscription auth can run Codex text/code tasks and attach images as input, but the installed Codex CLI does not expose a callable tool that creates PNG/JPEG image outputs. Configure a supported image backend before using this tool.",
    );
  }
  return apiKey;
}

function parseRetryNotBefore(value: string | null, nowMs = Date.now()): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0
      ? new Date(nowMs + Math.ceil(seconds * 1000))
      : null;
  }
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > nowMs ? parsed : null;
}

function classifyCredentialFailure(
  statusCode: number,
  providerErrorCode: string | null,
  providerErrorType: string | null,
  message: string,
): OpenAiImageCredentialFailureKind | null {
  const evidence = `${providerErrorCode ?? ""} ${providerErrorType ?? ""} ${message}`.toLowerCase();
  if (/insufficient(?:_| )quota|billing(?:_| )hard(?:_| )limit|quota (?:is )?exceeded|usage limit/.test(evidence)) {
    return "quota";
  }
  if (statusCode === 401 || statusCode === 403 || /invalid(?:_| )api(?:_| )key|incorrect api key/.test(evidence)) {
    return "auth";
  }
  if (statusCode !== 429) return null;
  return "rate_limit";
}

function safeFilename(input: string | null, fallback: string): string {
  const candidate = input ? basename(input).replaceAll("\"", "").trim() : "";
  return candidate || fallback;
}

async function parseOpenAiImageResponse(response: Response, fetchImpl: typeof fetch): Promise<Buffer> {
  let body: OpenAiImageResponse | null = null;
  try {
    body = await response.json() as OpenAiImageResponse;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message = typeof body?.error?.message === "string"
      ? body.error.message
      : `OpenAI image generation failed with ${response.status}`;
    const providerErrorCode = typeof body?.error?.code === "string" ? body.error.code : null;
    const providerErrorType = typeof body?.error?.type === "string" ? body.error.type : null;
    throw new OpenAiImageProviderError({
      message,
      statusCode: response.status,
      providerErrorCode,
      providerRequestId: response.headers.get("x-request-id"),
      retryNotBefore: parseRetryNotBefore(response.headers.get("retry-after")),
      credentialFailureKind: classifyCredentialFailure(
        response.status,
        providerErrorCode,
        providerErrorType,
        message,
      ),
    });
  }

  const first = body?.data?.[0];
  if (typeof first?.b64_json === "string" && first.b64_json.length > 0) {
    return Buffer.from(first.b64_json, "base64");
  }

  if (typeof first?.url === "string" && first.url.length > 0) {
    const assetResponse = await fetchImpl(first.url);
    if (!assetResponse.ok) {
      throw unprocessable(`OpenAI image asset download failed with ${assetResponse.status}`);
    }
    return Buffer.from(await assetResponse.arrayBuffer());
  }

  throw unprocessable("OpenAI image generation returned no image data");
}

export async function generateOpenAiIssueImage(input: GenerateOpenAiImageInput): Promise<GenerateOpenAiImageResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiKey = resolveOpenAiImageApiKey(input.apiKey, input.allowEnvironmentFallback ?? true);
  const generationMode: GenerationMode = input.references.length > 0 ? "reference_backed" : "prompt_only";
  const endpoint = generationMode === "reference_backed" ? OPENAI_IMAGE_EDIT_URL : OPENAI_IMAGE_GENERATION_URL;
  const form = new FormData();

  form.set("model", PAPERCLIP_IMAGE_MODEL);
  form.set("prompt", input.prompt);
  form.set("size", input.size);
  form.set("quality", input.quality);

  for (const reference of input.references) {
    const blobBytes = new Uint8Array(reference.bytes.length);
    blobBytes.set(reference.bytes);
    form.append(
      "image[]",
      new Blob([blobBytes], { type: reference.contentType }),
      safeFilename(reference.filename, `${reference.attachmentId}.png`),
    );
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const outputBytes = await parseOpenAiImageResponse(response, fetchImpl);

  return {
    model: PAPERCLIP_IMAGE_MODEL,
    endpoint,
    generationMode,
    actualImageInputsBound: input.references.map(imageReferenceSourceId),
    outputBytes,
    outputContentType: "image/png",
    providerRequestId: response.headers.get("x-request-id"),
  };
}
