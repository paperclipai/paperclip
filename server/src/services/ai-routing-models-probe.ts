import dns from "node:dns/promises";
import net from "node:net";
import type { AiProviderRouting } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const PROBE_TIMEOUT_MS = 15_000;

/** Mirrors the routing schema's model-list cap so a huge catalog cannot bloat the stored connection. */
export const AI_ROUTING_MODELS_PROBE_LIMIT = 200;
/** Bounds the buffered response body from a caller-chosen endpoint. */
export const AI_ROUTING_MODELS_PROBE_MAX_BYTES = 1_000_000;
/** Stops entry collection before sorting; the byte cap bounds this in practice, this bounds CPU directly. */
const MAX_PARSED_ENTRIES = 1_000;

// The probe turns a member-supplied URL into a server-side fetch, so gateway
// hosts must resolve to public addresses. Loopback is intentionally allowed
// only through the separate `local` routing kind, which the route limits to
// the local operator. DNS is resolved once before the fetch; rebinding between
// resolution and connection is a documented residual risk, alongside the
// existing `redirect: "error"` guard.
const PRIVATE_V4 = new net.BlockList();
for (const [subnet, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) PRIVATE_V4.addSubnet(subnet, bits);
const PRIVATE_V6 = new net.BlockList();
PRIVATE_V6.addAddress("::1", "ipv6");
PRIVATE_V6.addSubnet("fc00::", 7, "ipv6");
PRIVATE_V6.addSubnet("fe80::", 10, "ipv6");
PRIVATE_V6.addSubnet("::ffff:0.0.0.0", 96, "ipv6");

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) return PRIVATE_V4.check(address, "ipv4");
  if (net.isIPv6(address)) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped) return PRIVATE_V4.check(mapped[1]!, "ipv4");
    return PRIVATE_V6.check(address, "ipv6");
  }
  return true;
}

export type ProbeLookup = (hostname: string) => Promise<string[]>;

export const defaultProbeLookup: ProbeLookup = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true });
  return results.map((result) => result.address);
};

/** Gate on who may reach which destination before any network call happens. */
export async function assertProbeDestinationAllowed(
  route: AiProviderRouting,
  isLocalOperator: boolean,
  lookup: ProbeLookup = defaultProbeLookup,
): Promise<void> {
  if (route.kind === "openrouter") return;
  if (route.kind === "local") {
    // A `local` route means loopback in the agent's execution environment.
    // The probe fetch runs on the Paperclip server itself, so only the
    // operator of that machine may use it to enumerate a loopback service.
    if (!isLocalOperator)
      throw unprocessable(
        "Local endpoint discovery runs on the Paperclip server's loopback. Only the local operator can list models there; connect a gateway URL instead.",
        { code: "ai_routing_models_probe_local_operator_only" },
      );
    return;
  }
  const rawHostname = new URL(route.baseUrl ?? "").hostname;
  // URL.hostname keeps the brackets on IPv6 literals; strip them for IP checks and lookup.
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  let addresses: string[];
  try {
    addresses = net.isIP(hostname) ? [hostname] : await lookup(hostname);
  } catch {
    // An unresolvable or mistyped host is a user-input problem, not a server error.
    throw unprocessable("Could not reach the endpoint. Check the URL and try again.", {
      code: "ai_routing_models_probe_unreachable",
    });
  }
  if (addresses.some((address) => isPrivateAddress(address)))
    throw unprocessable("The gateway URL must resolve to a public address.", {
      code: "ai_routing_models_probe_private_target",
    });
}

export function probeModelsUrl(route: AiProviderRouting): string {
  const base =
    route.kind === "openrouter"
      ? "https://openrouter.ai/api/v1"
      : (route.baseUrl ?? "").replace(/\/+$/, "");
  return `${base}/models`;
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
  request?: typeof fetch;
  timeoutMs?: number;
  isLocalOperator?: boolean;
  lookup?: ProbeLookup;
}

/** Lists models from a local or gateway endpoint (or OpenRouter) before the
 * connection is saved. The caller-supplied URL is constrained by the routing
 * schema (HTTPS except loopback, no embedded credentials), the destination is
 * checked before the fetch, and credentials are never sent through a redirect. */
export async function probeAiRoutingModels(
  route: AiProviderRouting,
  apiKey = "",
  options: ProbeOptions = {},
): Promise<Array<{ id: string; label: string }>> {
  if (route.kind === "bedrock")
    throw unprocessable("Bedrock does not expose an OpenAI-compatible model list. Enter model IDs manually.", { code: "ai_routing_models_probe_unsupported" });
  await assertProbeDestinationAllowed(route, options.isLocalOperator ?? false, options.lookup);
  let response: Response;
  try {
    response = await (options.request ?? fetch)(probeModelsUrl(route), {
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      headers: headersFor(route, apiKey),
    });
  } catch {
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
    if (error && typeof error === "object" && "status" in error) throw error;
    throw unprocessable("The endpoint did not return a JSON model list.", { code: "ai_routing_models_probe_invalid" });
  }
  return parseModelsResponse(payload);
}
