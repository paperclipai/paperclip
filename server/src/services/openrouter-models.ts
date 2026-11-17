import type { AdapterModel } from "@paperclipai/adapter-utils";
import { HttpError } from "../errors.js";
import { classifyRemoteConnectionError } from "./remote-connection-failure.js";

const CATALOG_URL = "https://openrouter.ai/api/v1/models?sort=most-popular";
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_UNAVAILABLE = "Could not load OpenRouter models. Retry or enter a model ID manually.";

let cached: { until: number; models: AdapterModel[] } | undefined;
let pending: Promise<AdapterModel[]> | undefined;

// Local provenance: only errors this module created for an actual outage of
// the public catalog (its own deadline, a classified transport failure, or a
// rate-limit/server status). They affect crash reporting only.
const unavailable = new WeakSet<Error>();

function catalogUnavailable(): HttpError {
  const error = new HttpError(503, CATALOG_UNAVAILABLE, { code: "openrouter_catalog_unavailable" });
  unavailable.add(error);
  return error;
}

/** The public OpenRouter catalog was unreachable; this is not a Paperclip fault. */
export function isOpenRouterCatalogUnavailable(error: unknown): boolean {
  return error instanceof HttpError && unavailable.has(error);
}

/** Map a failure of the outbound catalog request; rethrow anything else unchanged. */
function requestFailure(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted || classifyRemoteConnectionError(error) ? catalogUnavailable() : error;
}

/** OpenRouter's public catalog does not require access to anyone's credentials. */
export async function listOpenRouterModels(refresh = false): Promise<AdapterModel[]> {
  if (!refresh && cached && cached.until > Date.now()) return cached.models;
  if (pending) return pending;
  pending = (async () => {
    const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
    let body: { data?: Array<{ id?: unknown; name?: unknown }> };
    try {
      const response = await fetch(CATALOG_URL, { signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 408 || response.status === 429 || response.status >= 500) throw catalogUnavailable();
        throw new HttpError(502, CATALOG_UNAVAILABLE, { code: "openrouter_catalog_error", status: response.status });
      }
      body = await response.json() as typeof body;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw requestFailure(error, signal);
    }
    if (!Array.isArray(body.data)) throw new Error("OpenRouter returned an invalid model catalog.");
    const models = body.data.flatMap(model => typeof model.id === "string" && model.id.includes("/")
      ? [{ id: `openrouter/${model.id}`, label: typeof model.name === "string" ? model.name : model.id }]
      : []);
    cached = { until: Date.now() + 60_000, models };
    return models;
  })();
  try { return await pending; } finally { pending = undefined; }
}
