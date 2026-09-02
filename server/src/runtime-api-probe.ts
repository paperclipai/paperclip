/**
 * Startup validation for the runtime API URL handed to spawned agent runs.
 *
 * `PAPERCLIP_API_URL` is exported into every run so an agent can call its own
 * board. An operator override is deliberately authoritative, because a derived
 * public origin is often unreachable from inside a runtime container. Nothing
 * checked that the override actually answers the board API, though: point it at
 * a UI origin or an auth proxy and every board call gets HTML back. A
 * deterministic `process` agent surfaces that as an anonymous non-zero exit,
 * one agent at a time, hours after the misconfiguration landed.
 *
 * So probe the resolved URL once, at boot, as soon as the listener is up, and
 * fall back to a candidate origin that does answer. The probe is a routing
 * check, not a health check: a Paperclip-shaped health response means the board
 * API is on the other end, including a `503 unhealthy` one.
 */

export const RUNTIME_API_PROBE_PATH = "/api/health";
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
// `application/json`, plus structured suffixes such as `application/problem+json`.
const JSON_CONTENT_TYPE_RE = /^application\/(?:[\w.+-]+\+)?json\b/i;

const HEALTH_STATUS_VALUES = new Set(["ok", "unhealthy"]);
/**
 * Fields that only Paperclip's own `/api/health` serves. Every response variant
 * of that route carries at least one: `deploymentMode` on the redacted
 * (unauthenticated) shape, `serverVersion`/`serverInfo` on the full-detail and
 * `503 unhealthy` shapes.
 *
 * `version` and `commit` are deliberately not on this list — plenty of unrelated
 * services publish those on a health route.
 */
const PAPERCLIP_HEALTH_MARKERS = ["deploymentMode", "serverVersion", "serverInfo"] as const;

/**
 * Whether a parsed body is Paperclip's health response rather than some other
 * service's.
 *
 * "Answers JSON" is not a strong enough identity signal: spawned runs attach
 * their bearer run token to every request they send to this origin, so an
 * unrelated `/api/health` returning `{"status":"ok"}` must not be accepted as
 * the board API. A false negative is the safe direction — a rejected candidate
 * either loses to a later one or leaves the configured URL in place, unverified
 * and loudly logged.
 */
function isPaperclipHealthBody(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const body = parsed as Record<string, unknown>;
  if (typeof body.status !== "string" || !HEALTH_STATUS_VALUES.has(body.status)) return false;
  return PAPERCLIP_HEALTH_MARKERS.some((key) => key in body);
}

export type RuntimeApiProbeResult =
  | { ok: true; status: number }
  | { ok: false; reason: string };

export type RuntimeApiProbe = (apiUrl: string) => Promise<RuntimeApiProbeResult>;

export function runtimeApiProbeUrl(apiUrl: string): string | null {
  try {
    return new URL(RUNTIME_API_PROBE_PATH, new URL(apiUrl).origin).toString();
  } catch {
    return null;
  }
}

export async function probeRuntimeApiUrl(
  apiUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RuntimeApiProbeResult> {
  const probeUrl = runtimeApiProbeUrl(apiUrl);
  if (!probeUrl) return { ok: false, reason: "is not a parseable absolute URL" };

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(probeUrl, {
      method: "GET",
      // An auth proxy answers with a redirect to its own sign-in page. Following
      // it would report the proxy's HTML as if the API had served it, so keep the
      // redirect visible and name its target in the rejection reason.
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      return {
        ok: false,
        reason: `redirected (HTTP ${response.status}${location ? ` to ${location}` : ""}) instead of serving the API`,
      };
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !JSON_CONTENT_TYPE_RE.test(contentType.trim())) {
      return {
        ok: false,
        reason: `answered HTTP ${response.status} with content-type ${contentType ?? "(none)"} instead of JSON`,
      };
    }

    // A proxy can label an HTML error page `application/json`. Parsing is the
    // cheap confirmation that an API, not a front door, is on the other end.
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      return {
        ok: false,
        reason: `answered HTTP ${response.status} with a JSON content-type but an unparseable body`,
      };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: `answered HTTP ${response.status} with a JSON body that is not an API response object`,
      };
    }
    if (!isPaperclipHealthBody(parsed)) {
      return {
        ok: false,
        reason: `answered HTTP ${response.status} with JSON that is not a Paperclip ${RUNTIME_API_PROBE_PATH} response`,
      };
    }

    return { ok: true, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      reason: timedOut ? `did not answer within ${timeoutMs}ms` : `could not be reached (${message})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface RuntimeApiUrlResolution {
  /** The URL to export as `PAPERCLIP_API_URL` for spawned runs. */
  apiUrl: string;
  /** True when the configured URL failed and `apiUrl` is a fallback. */
  changed: boolean;
  /** Every candidate that failed the probe, in the order it was tried. */
  rejected: Array<{ apiUrl: string; reason: string }>;
  /**
   * True when no candidate answered. `apiUrl` is then the configured value,
   * unverified — the server keeps booting because refusing to start would take
   * the API away from external clients that may well be able to reach it.
   */
  unverified: boolean;
}

/**
 * Pick the first origin that answers the board API.
 *
 * The configured URL is always tried first, so the healthy case costs exactly
 * one local request and the operator override keeps winning whenever it works.
 */
export async function resolveVerifiedRuntimeApiUrl(input: {
  configuredApiUrl: string;
  fallbackApiUrls: string[];
  probe: RuntimeApiProbe;
}): Promise<RuntimeApiUrlResolution> {
  const configuredApiUrl = input.configuredApiUrl.trim();
  const rejected: Array<{ apiUrl: string; reason: string }> = [];
  const tried = new Set<string>();

  for (const candidate of [configuredApiUrl, ...input.fallbackApiUrls]) {
    const apiUrl = candidate?.trim();
    if (!apiUrl || tried.has(apiUrl)) continue;
    tried.add(apiUrl);

    const result = await input.probe(apiUrl);
    if (result.ok) {
      return { apiUrl, changed: apiUrl !== configuredApiUrl, rejected, unverified: false };
    }
    rejected.push({ apiUrl, reason: result.reason });
  }

  return { apiUrl: input.configuredApiUrl, changed: false, rejected, unverified: true };
}
