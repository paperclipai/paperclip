const MODELS_URL = "https://api.kimi.ai/coding/v1/models";
const USER_AGENT = "KimiCLI/2.3.3";
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;

export type KimiMetadataProbeErrorCode =
  | "KIMI_AUTH_REQUIRED"
  | "KIMI_AUTH_REJECTED"
  | "KIMI_MODEL_UNAVAILABLE"
  | "KIMI_METADATA_TIMEOUT"
  | "KIMI_METADATA_INVALID"
  | "KIMI_PROVIDER_ERROR";

const messages: Record<KimiMetadataProbeErrorCode, string> = {
  KIMI_AUTH_REQUIRED: "Bind a valid company secret to KIMI_API_KEY.",
  KIMI_AUTH_REJECTED: "Kimi Code rejected the selected credential or account access. Check the credential and Code membership.",
  KIMI_MODEL_UNAVAILABLE: "The exact selected model is unavailable in the authenticated Kimi Code catalog.",
  KIMI_METADATA_TIMEOUT: "Kimi Code model verification timed out.",
  KIMI_METADATA_INVALID: "Kimi Code returned invalid model metadata.",
  KIMI_PROVIDER_ERROR: "Kimi Code model verification failed. Try again when the provider is available.",
};

export class KimiMetadataProbeError extends Error {
  readonly code: KimiMetadataProbeErrorCode;
  readonly status?: number;

  constructor(code: KimiMetadataProbeErrorCode, status?: number) {
    super(messages[code]);
    this.name = "KimiMetadataProbeError";
    this.code = code;
    this.status = status;
  }
}

export interface KimiVerifiedModelMetadata {
  code: "kimi_metadata_verified";
  model: string;
  contextLength: number;
  message: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function selectedModel(payload: unknown, requestedModel: string): number {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) throw new KimiMetadataProbeError("KIMI_METADATA_INVALID");
  const ids = new Set<string>();
  let contextLength: number | undefined;
  for (const value of data) {
    const row = record(value);
    const id = row?.id;
    const context = record(row?.limit)?.context;
    const parsed = typeof context === "number" || (typeof context === "string" && /^[0-9]+$/.test(context)) ? Number(context) : NaN;
    if (typeof id !== "string" || !id.trim() || ids.has(id) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new KimiMetadataProbeError("KIMI_METADATA_INVALID");
    }
    ids.add(id);
    if (id === requestedModel) contextLength = parsed;
  }
  if (contextLength === undefined) throw new KimiMetadataProbeError("KIMI_MODEL_UNAVAILABLE");
  return contextLength;
}

export async function probeKimiModels(
  model: string,
  apiKey: string,
  testDependencies?: { fetch: typeof globalThis.fetch },
): Promise<KimiVerifiedModelMetadata> {
  if (typeof apiKey !== "string" || !apiKey.trim() || Buffer.byteLength(apiKey) > 16 * 1024 || /[\0\r\n]/.test(apiKey)) {
    throw new KimiMetadataProbeError("KIMI_AUTH_REQUIRED");
  }
  if (typeof model !== "string" || !model.trim() || Buffer.byteLength(model) > 512 || model.includes("\0")
    || Buffer.from(model).toString("utf8") !== model) throw new KimiMetadataProbeError("KIMI_MODEL_UNAVAILABLE");
  const controller = new AbortController();
  const timeoutError = new KimiMetadataProbeError("KIMI_METADATA_TIMEOUT");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort(timeoutError);
    void reader?.cancel().catch(() => {});
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const request = Promise.resolve().then(() => (testDependencies?.fetch ?? globalThis.fetch)(MODELS_URL, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": USER_AGENT },
    })).then(value => {
      if (controller.signal.aborted) {
        void value.body?.cancel().catch(() => {});
        throw timeoutError;
      }
      return value;
    });
    response = await Promise.race([request, aborted]);
    if (!response.ok) throw new KimiMetadataProbeError(
      [401, 402, 403].includes(response.status) ? "KIMI_AUTH_REJECTED" : "KIMI_PROVIDER_ERROR", response.status,
    );
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_BYTES)) {
      controller.abort();
      throw new KimiMetadataProbeError("KIMI_METADATA_INVALID");
    }
    if (!response.body) throw new KimiMetadataProbeError("KIMI_METADATA_INVALID");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (controller.signal.aborted) throw timeoutError;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) {
        controller.abort();
        throw new KimiMetadataProbeError("KIMI_METADATA_INVALID");
      }
      chunks.push(chunk.value);
    }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { throw new KimiMetadataProbeError("KIMI_METADATA_INVALID"); }
    const contextLength = selectedModel(payload, model);
    return { code: "kimi_metadata_verified", model, contextLength,
      message: "Kimi Code accepted the selected credential and listed the exact selected model. No model prompt was sent; inference and remaining quota were not tested." };
  } catch (error) {
    if (error instanceof KimiMetadataProbeError) throw error;
    throw new KimiMetadataProbeError(controller.signal.aborted ? "KIMI_METADATA_TIMEOUT" : "KIMI_PROVIDER_ERROR");
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    if (reader) {
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    } else { void response?.body?.cancel().catch(() => {}); }
  }
}
