import dns from "node:dns/promises";
import type { AiProviderRouting } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import {
  resolveApprovedRemoteHttpAddresses,
  type RemoteHttpEndpointErrorFactory,
  type RemoteHttpEndpointLookup,
} from "./remote-http-endpoint-guard.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

const PROBE_TIMEOUT_MS = 15_000;

/** Mirrors the routing schema's model-list cap so a huge catalog cannot bloat the stored connection. */
export const AI_ROUTING_MODELS_PROBE_LIMIT = 200;
/** Bounds the buffered response body from a caller-chosen endpoint. */
export const AI_ROUTING_MODELS_PROBE_MAX_BYTES = 1_000_000;
/** Stops entry collection before sorting; the byte cap bounds this in practice, this bounds CPU directly. */
const MAX_PARSED_ENTRIES = 1_000;

export const defaultProbeLookup: RemoteHttpEndpointLookup = (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

export const probeErrorFactory: RemoteHttpEndpointErrorFactory = (message, code) => {
  if (code === "remote_http_private_endpoint")
    return unprocessable("The gateway URL must resolve to a public address.", {
      code: "ai_routing_models_probe_private_target",
    });
  if (code === "remote_http_dns_failed")
    return unprocessable("Could not reach the endpoint. Check the URL and try again.", {
      code: "ai_routing_models_probe_unreachable",
    });
  return unprocessable(message, { code: "ai_routing_models_probe_failed" });
};

/** Policy gate: who may probe which destination kind. The network safety
 * checks (private/reserved classification, DNS pinning, peer re-check) belong
 * to the shared remote-http guard; this is authorization only. A `local` route
 * means loopback in the agent's execution environment, but the probe fetch
 * runs on the Paperclip server itself, so only the operator of that machine
 * may use it to enumerate a loopback service. */
export async function assertProbeDestinationAllowed(
  route: AiProviderRouting,
  isLocalOperator: boolean,
  lookup?: RemoteHttpEndpointLookup,
): Promise<void> {
  if (route.kind === "openrouter") return;
  if (route.kind === "local") {
    if (!isLocalOperator)
      throw unprocessable(
        "Local endpoint discovery runs on the Paperclip server's loopback. Only the local operator can list models there; connect a gateway URL instead.",
        { code: "ai_routing_models_probe_local_operator_only" },
      );
    return;
  }
  // Gateway: run the same classification the production fetch path uses, so
  // this check is meaningful on the test seam too (where the transport is
  // injected and the guard would not run).
  await resolveApprovedRemoteHttpAddresses(
    new URL(route.baseUrl ?? ""),
    { ...(lookup ? { lookup } : {}) },
    probeErrorFactory,
  );
}

export function probeModelsUrl(route: AiProviderRouting): string {
  if (route.kind === "openrouter") return "https://openrouter.ai/api/v1/models";
  const base = (route.baseUrl ?? "").replace(/\/+$/, "");
  // The Claude harness points ANTHROPIC_BASE_URL at the bare gateway and reads
  // its model list from {base}/v1/models. OpenAI-compatible chat and responses
  // endpoints take the operator's base URL as-is (which includes /v1) and
  // serve {base}/models.
  return route.protocol === "messages" ? `${base}/v1/models` : `${base}/models`;
}

function headersFor(route: AiProviderRouting, apiKey: string): Record<string, string> {
  if (route.auth === "none") return {};
  if (route.auth === "api_key") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  return { Authorization: `Bearer ${apiKey}` };
}

/** Reads the body with a hard byte ceiling and cancels the stream when it is exceeded. */
export async function readBodyWithLimit(response: Response, maxBytes = AI_ROUTING_MODELS_PROBE_MAX_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw unprocessable("The endpoint's model list is too large.", { code: "ai_routing_models_probe_too_large" });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parses an OpenAI-compatible `{"object":"list","data":[{"id":...}]}` model list. */
export function parseModelsResponse(payload: unknown): Array<{ id: string; label: string }> {
  const data =
    typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const seen = new Set<string>();
  const models: Array<{ id: string; label: string }> = [];
  for (const entry of data) {
    if (models.length >= MAX_PARSED_ENTRIES) break;
    const id =
      typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
        ? (entry as { id: string }).id.trim()
        : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }))
    .slice(0, AI_ROUTING_MODELS_PROBE_LIMIT);
}

export interface ProbeOptions {
  /** Test seam: injected transport. Production uses the guarded fetch. */
  request?: typeof fetch;
  timeoutMs?: number;
  isLocalOperator?: boolean;
  lookup?: RemoteHttpEndpointLookup;
}

/** Lists models from a local or gateway endpoint (or OpenRouter) before the
 * connection is saved. The caller-supplied URL is constrained by the routing
 * schema (HTTPS except loopback, no embedded credentials), classified by the
 * shared remote-http guard (private/reserved ranges, DNS pinning, peer
 * re-check, no redirects), and credentials are never sent through a redirect. */
export async function probeAiRoutingModels(
  route: AiProviderRouting,
  apiKey = "",
  options: ProbeOptions = {},
): Promise<Array<{ id: string; label: string }>> {
  if (route.kind === "bedrock")
    throw unprocessable("Bedrock does not expose an OpenAI-compatible model list. Enter model IDs manually.", { code: "ai_routing_models_probe_unsupported" });
  if (route.kind === "local" && !(options.isLocalOperator ?? false))
    await assertProbeDestinationAllowed(route, false);
  const url = probeModelsUrl(route);
  const init: RequestInit = {
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    headers: headersFor(route, apiKey),
  };
  let response: Response;
  try {
    if (options.request) {
      // Test seam: run the guard's classification against the injected lookup,
      // then hand off to the injected transport.
      await assertProbeDestinationAllowed(route, options.isLocalOperator ?? false, options.lookup);
      response = await options.request(url, init);
    } else {
      response = await guardedRemoteHttpFetch(url, init, {
        allowPrivateNetwork: route.kind === "local",
        ...(options.lookup ? { lookup: options.lookup } : {}),
        error: probeErrorFactory,
      });
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // A TLS failure against a plain-HTTP model server (Ollama and friends) is
    // the common scheme mistake; name it instead of a generic unreachable.
    const code = (error as { cause?: { code?: string } })?.cause?.code ?? "";
    if (code.includes("TLS") || code.includes("SSL") || ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED"].includes(code)) {
      const loopback = /^https:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
      throw unprocessable(
        loopback
          ? "This local endpoint refused HTTPS. Local model servers such as Ollama serve plain HTTP; check the URL scheme."
          : "The endpoint refused a TLS connection. Check the URL scheme and certificate.",
        { code: "ai_routing_models_probe_unreachable" },
      );
    }
    throw unprocessable("Could not reach the endpoint. Check the URL and try again.", { code: "ai_routing_models_probe_unreachable" });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw unprocessable(
      response.status === 401 || response.status === 403
        ? "The endpoint rejected the credentials."
        : "The endpoint could not list models. Try again.",
      { code: response.status === 401 || response.status === 403 ? "ai_routing_models_probe_unauthorized" : "ai_routing_models_probe_failed" },
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBodyWithLimit(response));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unprocessable("The endpoint did not return a JSON model list.", { code: "ai_routing_models_probe_invalid" });
  }
  return parseModelsResponse(payload);
}
