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
 * fall back to an origin that does answer. The probe is a routing check, not a
 * health check: a Paperclip-shaped health response means the board API is on
 * the other end, including a `503 unhealthy` one.
 *
 * A spawned run attaches its bearer run token to whatever origin wins, so the
 * two candidates are not interchangeable and the check is deliberately narrow:
 *
 * - The **configured** URL is the operator's own explicit choice, and it is
 *   what every run already inherited before this check existed. The probe can
 *   only ever reject it, never widen where credentials go, so the board health
 *   shape is signal enough to keep it.
 * - The **fallback** is chosen by this server, so promoting it is the only way
 *   this check could send a run somewhere new. No response body can prove the
 *   responder is this server: every self-identifying value the health route
 *   publishes (`commit`, `serverVersion`) is readable off that same route by
 *   anything that can reach it, so any process able to answer the probe can
 *   also echo whatever the probe wants to see. The single fallback is therefore
 *   authenticated by construction rather than by content — it is built from the
 *   address this process actually bound (see {@link runtimeSelfOriginApiUrl}),
 *   an origin no other process can be holding. There is no second fallback,
 *   because there is no second origin that can be proven to be us.
 *
 * Dropping the wider candidate list from this decision costs nothing a run can
 * use: runtime clients still walk `PAPERCLIP_RUNTIME_API_CANDIDATES_JSON` at
 * request time. What changes is that no unauthenticated response can promote
 * one of those origins to the credential-bearing default.
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
 * The one origin this process can prove is itself: the address it actually
 * bound, on the port it actually bound.
 *
 * Identity here is a property of the socket, not of anything the responder
 * says. A bound `addr:port` cannot simultaneously be held by another process,
 * so a request to it reaches this server or it fails. A wildcard bind occupies
 * the port on every address of its family, which includes that family's
 * loopback address — preferred over the routable addresses a wildcard bind also
 * covers, because loopback cannot leave the host.
 *
 * Returns `null` for a listener with no HTTP origin (a UNIX socket) or an
 * unusable port. There is then no fallback, and a failing configured URL is
 * left in place, loudly, rather than replaced by an unprovable origin.
 */
export function runtimeSelfOriginApiUrl(
  boundAddress: { address?: string | null; port?: number | null } | string | null | undefined,
): string | null {
  if (!boundAddress || typeof boundAddress === "string") return null;
  const port = boundAddress.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return null;

  const host = (boundAddress.address ?? "").trim();
  if (!host) return null;

  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  // `0.0.0.0` holds the port on 127.0.0.1; `::` holds it on ::1 (and, in
  // dual-stack mode, on 127.0.0.1 too — but ::1 is ours under either setting).
  if (normalized === "0.0.0.0") return `http://127.0.0.1:${port}`;
  if (normalized === "::") return `http://[::1]:${port}`;

  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketed}:${port}`;
}

/**
 * Whether a parsed body is Paperclip's health response rather than some other
 * service's.
 *
 * "Answers JSON" is not a strong enough signal to keep a configured URL that
 * spawned runs then send a bearer token to: an unrelated `/api/health`
 * returning `{"status":"ok"}` must not read as the board API. A false negative
 * is the safe direction — it costs the configured URL its verification, and the
 * rejection is logged with the URL named.
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
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
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
  /** True when the configured URL failed and `apiUrl` is this server's own origin. */
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
 * Resolve the URL spawned runs inherit: the configured one if it answers the
 * board API, otherwise this server's own bound origin if that does.
 *
 * The configured URL is always tried first, so the healthy case costs exactly
 * one local request and the operator override keeps winning whenever it works.
 * See the two-candidate note at the top of this module for why the fallback is
 * a single construction-authenticated origin rather than a candidate list.
 */
export async function resolveVerifiedRuntimeApiUrl(input: {
  configuredApiUrl: string;
  /**
   * This process's own bound origin, from {@link runtimeSelfOriginApiUrl}.
   * `null` when the listener has no usable HTTP origin, which leaves a failing
   * configured URL in place rather than promoting an origin that cannot be
   * proven to be us.
   */
  selfOriginApiUrl: string | null;
  probe: RuntimeApiProbe;
}): Promise<RuntimeApiUrlResolution> {
  const configuredApiUrl = input.configuredApiUrl.trim();
  const selfOriginApiUrl = input.selfOriginApiUrl?.trim() || null;
  const rejected: Array<{ apiUrl: string; reason: string }> = [];

  for (const apiUrl of [configuredApiUrl, selfOriginApiUrl]) {
    if (!apiUrl) continue;
    // The self origin can be exactly what the operator configured; probing it a
    // second time would only repeat the same verdict.
    if (rejected.some((entry) => entry.apiUrl === apiUrl)) continue;

    const result = await input.probe(apiUrl);
    if (result.ok) {
      return { apiUrl, changed: apiUrl !== configuredApiUrl, rejected, unverified: false };
    }
    rejected.push({ apiUrl, reason: result.reason });
  }

  return { apiUrl: input.configuredApiUrl, changed: false, rejected, unverified: true };
}
