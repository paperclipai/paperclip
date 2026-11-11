import { z } from "zod";
import type { TypesafeAskResult } from "@paperclipai/shared";

const BASE_URL = "https://api.typesafe.ai/v1";
export const TYPESAFE_GALLERY_KEY = "typesafe";
export const TYPESAFE_HEALTH_MESSAGE = "TypeSafe API key is connected.";

export function isTypesafeConnection(connection: {
  transport: string;
  config: Record<string, unknown>;
}) {
  return (
    connection.transport === "rest_api" &&
    connection.config.sourceTemplateKey === TYPESAFE_GALLERY_KEY
  );
}
interface TypesafeFailure {
  code: string;
  httpStatus: number;
  retryable: boolean;
}
const KEY_REJECTED: TypesafeFailure = {
  code: "typesafe_api_key_rejected",
  httpStatus: 502,
  retryable: false,
};
const REQUEST_FAILED: TypesafeFailure = {
  code: "typesafe_request_failed",
  httpStatus: 502,
  retryable: false,
};
const INVALID_RESPONSE: TypesafeFailure = {
  code: "typesafe_invalid_response",
  httpStatus: 502,
  retryable: false,
};
const UNREACHABLE: TypesafeFailure = {
  code: "typesafe_unreachable",
  httpStatus: 503,
  retryable: true,
};
const INVALID_REQUEST: TypesafeFailure = {
  code: "typesafe_invalid_request",
  httpStatus: 422,
  retryable: false,
};
const FAILURES: Record<number, TypesafeFailure> = {
  400: INVALID_REQUEST,
  401: KEY_REJECTED,
  403: KEY_REJECTED,
  422: INVALID_REQUEST,
  429: { code: "typesafe_rate_limited", httpStatus: 429, retryable: true },
  529: { code: "typesafe_overloaded", httpStatus: 503, retryable: true },
};

export class TypesafeApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  constructor(
    readonly status: number,
    failure: TypesafeFailure = FAILURES[status] ?? REQUEST_FAILED,
  ) {
    super(
      failure === INVALID_RESPONSE
        ? "TypeSafe returned a response Paperclip could not read"
        : failure === UNREACHABLE
          ? "TypeSafe did not respond"
          : `TypeSafe request failed (${status})`,
    );
    this.code = failure.code;
    this.httpStatus = failure.httpStatus;
    this.retryable = failure.retryable;
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
    }).catch(() => {
      throw new TypesafeApiError(0, UNREACHABLE);
    });
    if (!response.ok) throw new TypesafeApiError(response.status);
    const text = await response.text().catch(() => {
      throw new TypesafeApiError(0, UNREACHABLE);
    });
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  function read<T>(schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new TypesafeApiError(502, INVALID_RESPONSE);
    return parsed.data;
  }
  return {
    listModels: async () =>
      read(modelsSchema, await request("/models")).models.map(
        (model) => model.name,
      ),
    evaluate: async (body: TypesafeEvaluateRequest): Promise<TypesafeAskResult> =>
      read(resultSchema, await request("/systemone", body)),
  };
}
