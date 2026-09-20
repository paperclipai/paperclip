import { z } from "zod";
import type { TypesafeAskResult } from "@paperclipai/shared";

const BASE_URL = "https://api.typesafe.ai/v1";
const CODES = {
  401: "typesafe_unauthorized",
  422: "typesafe_invalid_request",
  429: "typesafe_rate_limited",
  529: "typesafe_overloaded",
} as const;
export type TypesafeApiErrorCode =
  | (typeof CODES)[keyof typeof CODES]
  | "typesafe_request_failed";

export class TypesafeApiError extends Error {
  readonly code: TypesafeApiErrorCode;
  readonly retryable: boolean;
  constructor(readonly status: number) {
    // Provider bodies may echo submitted state. Never log them.
    super(`TypeSafe request failed (${status})`);
    this.code = CODES[status as keyof typeof CODES] ?? "typesafe_request_failed";
    this.retryable = status === 429 || status === 529;
  }
}

const modelsSchema = z.object({
  models: z.array(z.object({ name: z.string().min(1) })),
});
const probabilities = z.record(z.string(), z.number());
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities,
    confidence: z.number(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities,
    confidence: z.number(),
  }),
]);
const resultSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export interface TypesafeEvaluateRequest {
  state: unknown;
  model: string;
  questions: Record<string, unknown>;
}

/** Credentials stay on the server; agents only ever see answers. */
export function typesafeApi(apiKey: string, fetchImpl: typeof fetch = fetch) {
  async function request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetchImpl(`${BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new TypesafeApiError(response.status);
    return response.json();
  }
  return {
    listModels: async () =>
      modelsSchema
        .parse(await request("/models"))
        .models.map((model) => model.name),
    evaluate: async (body: TypesafeEvaluateRequest): Promise<TypesafeAskResult> =>
      resultSchema.parse(await request("/systemone", body)),
  };
}
