import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { issues, projects, type Db } from "@paperclipai/db";
import type { ActivityPublication } from "../activity-log.js";
import { createCostEventInTransaction } from "../costs.js";
import { openRunnerWorkspaceFile } from "./runner-api-files.js";

/**
 * Codex hides its built-in image tool unless it is signed in with ChatGPT
 * (codex-rs core/src/tools/spec_plan.rs `image_generation_available`), and the
 * runner keeps the provider key out of the agent's shell. For an OpenAI API-key
 * agent this server-side tool makes the image with that existing key instead.
 */
export const GENERATE_IMAGE = "generate_image";
export const GENERATE_IMAGE_MODEL = "gpt-image-2";
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
// Base64 of the largest accepted PNG plus room for the JSON envelope.
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;

export const generateImageSchema = z.object({
  prompt: z.string().trim().min(1).max(8000).describe("What to draw. Include subject, style, colors and any exact text."),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("1024x1024"),
  quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/).optional()
    .describe("Short lowercase file name stem, for example cake-logo. A unique suffix and .png are added."),
}).strict();
export type GenerateImageInput = z.infer<typeof generateImageSchema>;

export const GENERATE_IMAGE_DEFINITION = {
  name: GENERATE_IMAGE,
  description: "Generate a new raster image (PNG) with OpenAI's image model, using this agent's existing OpenAI connection. "
    + "No extra API key is needed. Use this instead of the imagegen skill's built-in image_gen tool or scripts/image_gen.py, which are unavailable here. "
    + "The image is saved as a new file in the workspace root and the result gives its relative path; move or copy it from there, "
    + "and use register_deliverable if the user should receive it. Each call is billed to this agent's budget, so generate only what the task needs.",
  inputSchema: z.toJSONSchema(generateImageSchema),
};

/** Only a native Codex run on an OpenAI API-key connection, without custom routing, gets the tool. */
export function imageGenerationBindingForRun(input: {
  providerKind: string;
  contextSnapshot: unknown;
}): { connectionId: string; grantId: string } | undefined {
  if (input.providerKind !== "codex") return undefined;
  const snapshot = record(input.contextSnapshot);
  if (snapshot.aiRouterSelection || snapshot.managedAiRouting) return undefined;
  const connection = record(snapshot.aiConnection);
  if (connection.provider !== "openai" || connection.method !== "api_key") return undefined;
  if (typeof connection.connectionId !== "string" || typeof connection.grantId !== "string") return undefined;
  return { connectionId: connection.connectionId, grantId: connection.grantId };
}

export type GeneratedImage = {
  bytes: Buffer;
  model: string;
  providerRequestId: string | null;
  usage: { textInputTokens: number; imageInputTokens: number; outputTokens: number };
};

/** Calls the OpenAI Images API. The key is used only in this request header. */
export async function requestOpenAiImage(input: GenerateImageInput & { apiKey: string }, fetchImpl: typeof fetch = fetch,
  limits: { maxResponseBytes?: number } = {}): Promise<GeneratedImage> {
  const response = await fetchImpl(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: GENERATE_IMAGE_MODEL, prompt: input.prompt, size: input.size, quality: input.quality, n: 1 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await readBoundedText(response, limits.maxResponseBytes ?? MAX_RESPONSE_BYTES);
  let body: Record<string, unknown> = {};
  try { body = record(JSON.parse(text)); } catch { /* reported below */ }
  if (!response.ok) {
    // Provider messages are safe to show; they never include the request key.
    const message = typeof record(body.error).message === "string" ? String(record(body.error).message).slice(0, 500) : `HTTP ${response.status}`;
    throw new ImageGenerationProviderError(`OpenAI image generation failed: ${message}`, response.status);
  }
  const first = record(Array.isArray(body.data) ? body.data[0] : undefined);
  if (typeof first.b64_json !== "string") throw new ImageGenerationProviderError("OpenAI image generation returned no image", 502);
  const bytes = Buffer.from(first.b64_json, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ImageGenerationProviderError("OpenAI image generation returned an invalid PNG", 502);
  }
  const usage = record(body.usage);
  const details = record(usage.input_tokens_details);
  const inputTokens = count(usage.input_tokens);
  const imageInputTokens = count(details.image_tokens);
  return {
    bytes,
    model: GENERATE_IMAGE_MODEL,
    providerRequestId: response.headers.get("x-request-id"),
    usage: {
      // Text tokens default to all input tokens that are not reported as image input.
      textInputTokens: details.text_tokens === undefined ? Math.max(0, inputTokens - imageInputTokens) : count(details.text_tokens),
      imageInputTokens,
      outputTokens: count(usage.output_tokens),
    },
  };
}

/** Reads at most `limit` bytes; a larger reply is cancelled before it is parsed or decoded. */
async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageGenerationProviderError("OpenAI image generation returned a response that is too large", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ImageGenerationProviderError("OpenAI image generation returned a response that is too large", 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class ImageGenerationProviderError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

// Immutable, reviewed rate card (USD per 1M tokens, standard processing).
// https://developers.openai.com/api/docs/pricing (retrieved 2026-11-06)
const RATE_CARD_VERSION = "openai-image-standard-2026-11-06";
const RATES = { [GENERATE_IMAGE_MODEL]: { textInput: "5", imageInput: "8", imageOutput: "30" } } as const;

/** Token-price estimate for the budget ledger; not an invoice. Output is priced as image output. */
export function priceGeneratedImage(image: GeneratedImage) {
  const rates = RATES[image.model as keyof typeof RATES];
  const units = BigInt(image.usage.textInputTokens) * usdToUnits(rates.textInput)
    + BigInt(image.usage.imageInputTokens) * usdToUnits(rates.imageInput)
    + BigInt(image.usage.outputTokens) * usdToUnits(rates.imageOutput);
  const costCents = unitsToCents((units + 500_000n) / 1_000_000n);
  return {
    costCents,
    costUsd: centsToUsd(costCents),
    pricingProvenance: {
      source: "rate_card" as const,
      version: RATE_CARD_VERSION,
      evidence: "https://developers.openai.com/api/docs/pricing; image output rate applied to all output tokens",
      inputCentsPerMillion: unitsToCents(usdToUnits(rates.textInput)),
      outputCentsPerMillion: unitsToCents(usdToUnits(rates.imageOutput)),
      serviceTier: "standard",
    },
  };
}

/**
 * The cost row for one paid image. The idempotency key and the stored charge
 * time make every settlement of the same receipt record the charge once.
 */
export function imageChargeCostEvent(input: { agentId: string; issueId: string | null; runId: string; key: string; charge: Record<string, unknown> }) {
  const usage = record(input.charge.usage);
  const chargedAt = typeof input.charge.chargedAt === "string" && !Number.isNaN(Date.parse(input.charge.chargedAt)) ? new Date(input.charge.chargedAt) : new Date(0);
  return {
    agentId: input.agentId, issueId: input.issueId, projectId: typeof input.charge.projectId === "string" ? input.charge.projectId : null,
    heartbeatRunId: input.runId, provider: "openai", biller: "openai", billingType: "metered_api" as const, model: String(input.charge.model),
    costStatus: "estimated" as const, inputTokens: count(usage.textInputTokens) + count(usage.imageInputTokens), outputTokens: count(usage.outputTokens),
    costCents: String(input.charge.costCents), pricingProvenance: input.charge.pricingProvenance as never,
    providerRequestId: typeof input.charge.providerRequestId === "string" ? input.charge.providerRequestId : null,
    occurredAt: chargedAt, idempotencyKey: `image_gen:${input.runId}:${input.key}`,
  };
}

/**
 * Run accounting also settles paid images whose tool call never finished
 * recording them, so a lost acknowledgement cannot drop the spend.
 */
export async function settleChargedImageReceiptsInTransaction(tx: Db, run: { id: string; companyId: string; agentId: string; nativeIssueId: string | null; resultJson: unknown },
  publications: ActivityPublication[]): Promise<Array<string | null>> {
  const settled: Array<string | null> = [];
  for (const [key, value] of Object.entries(record(record(run.resultJson).imageToolReceipts))) {
    const receipt = record(value);
    if (receipt.state !== "charged" || !/^[a-f0-9]{64}$/.test(key)) continue;
    const event = imageChargeCostEvent({ agentId: run.agentId, issueId: run.nativeIssueId, runId: run.id, key, charge: record(receipt.charge) });
    // Deleted attribution targets become unallocated; spend is still recorded.
    if (event.issueId && !(await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, event.issueId), eq(issues.companyId, run.companyId))))[0]) event.issueId = null;
    if (event.projectId && !(await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, event.projectId), eq(projects.companyId, run.companyId))))[0]) event.projectId = null;
    await createCostEventInTransaction(tx, run.companyId, event, publications, undefined, { deferBudgetEvaluation: true });
    settled.push(event.projectId);
  }
  return settled;
}

/** Server-chosen, create-only destination in the workspace root. */
export function generatedImageDestination(name: string | undefined): string {
  return `${name ?? "generated-image"}-${randomBytes(4).toString("hex")}.png`;
}

export function imageIdentity(bytes: Buffer) {
  return { byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Local workspace write: symlink-confined, never overwrites an existing file. */
export async function writeGeneratedImageLocally(workspaceRoot: string, destination: string, bytes: Buffer): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}-[a-f0-9]{8}\.png$/.test(destination)) throw new Error("generated_image_path_denied");
  const target = join(await realpath(workspaceRoot), destination);
  const file = await openRunnerWorkspaceFile(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally { await file.close(); }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : 0;
}
