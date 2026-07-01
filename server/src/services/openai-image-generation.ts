import { basename } from "node:path";
import type { Readable } from "node:stream";
import { unprocessable } from "../errors.js";

export const PAPERCLIP_IMAGE_MODEL = "gpt-image-2";

const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_IMAGE_GENERATION_URL = "https://api.openai.com/v1/images/generations";

type GenerationMode = "prompt_only" | "reference_backed";

export interface ImageReferenceInput {
  attachmentId: string;
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

type OpenAiImageResponse = {
  data?: Array<{
    b64_json?: unknown;
    url?: unknown;
  }>;
  error?: {
    message?: unknown;
  };
};

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function resolveOpenAiImageApiKey(apiKeyOverride?: string | null): string {
  const apiKey =
    apiKeyOverride?.trim() ||
    process.env.PAPERCLIP_IMAGE_OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw unprocessable(
      "OPENAI_API_KEY is required to generate images. Assign an openai_api_key credential to the agent or set PAPERCLIP_IMAGE_OPENAI_API_KEY on the server.",
    );
  }
  return apiKey;
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
    throw unprocessable(message);
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
  const apiKey = resolveOpenAiImageApiKey(input.apiKey);
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
    actualImageInputsBound: input.references.map((reference) => reference.attachmentId),
    outputBytes,
    outputContentType: "image/png",
    providerRequestId: response.headers.get("x-request-id"),
  };
}
