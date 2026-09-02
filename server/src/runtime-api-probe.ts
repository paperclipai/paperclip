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
 *
 * Two candidate classes, two strictnesses, because spawned runs attach their
 * bearer run token to whatever origin wins:
 *
 * - The **configured** URL is the operator's own explicit choice, and it is
 *   what every run already inherited before this check existed. The probe can
 *   only ever reject it, never widen where credentials go, so the board health
 *   shape is signal enough to keep it.
 * - A **fallback** is chosen by this server, not the operator, so promoting one
 *   is the only way this check could send a run somewhere new. Every fallback
 *   candidate is built on this process's own bound port, so a fallback that is
 *   not this very build has no business winning: they must additionally echo
 *   our own `commit`. That is a value only this server knows it has, rather
 *   than a field name any service could publish.
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

/**
 * Extra strictness for a candidate this server chose for itself.
 *
 * `requireCommit` is this process's own build commit. When set, a candidate has
 * to report that same commit on its health response — proof it is this build and
 * not a co-located service that happens to publish Paperclip-shaped fields.
 * `null` waives the check: the caller either owns the URL (the operator's
 * configured value) or cannot read its own commit, in which case the board
 * health shape is the strongest signal available.
 */
export interface RuntimeApiProbeIdentity {
  requireCommit: string | null;
}

export type RuntimeApiProbe = (
  apiUrl: string,
  identity: RuntimeApiProbeIdentity,
) => Promise<RuntimeApiProbeResult>;

export function runtimeApiProbeUrl(apiUrl: string): string | null {
  try {
    return new URL(RUNTIME_API_PROBE_PATH, new URL(apiUrl).origin).toString();
  } catch {
    return null;
  }
}

/**
 * Whether a board health response came from this exact build.
 *
 * `commit` is the one self-identifying value on every variant of the route —
 * the redacted shape an unauthenticated caller gets carries it just as the
 * full-detail and `503 unhealthy` shapes do — so no authentication is needed to
 * check it. Returns a rejection reason, or `null` when the response is ours.
 */
function selfIdentityRejection(body: Record<string, unknown>, requireCommit: string): string | null {
  const commit = body.commit;
  if (typeof commit !== "string" || commit.length === 0) {
    return "reports no build commit, so it cannot be confirmed as this server";
  }
  if (commit !== requireCommit) {
    return `reports build commit ${commit}, not this server's ${requireCommit}`;
  }
  return null;
}

export async function probeRuntimeApiUrl(
  apiUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** See {@link RuntimeApiProbeIdentity}. Waived when absent. */
    requireCommit?: string | null;
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

    const requireCommit = options.requireCommit;
    if (requireCommit) {
      const mismatch = selfIdentityRejection(parsed as Record<string, unknown>, requireCommit);
      if (mismatch) {
        return {
          ok: false,
          reason: `served a Paperclip ${RUNTIME_API_PROBE_PATH} response but ${mismatch}`,
        };
      }
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
 * Only the fallbacks after it are held to the self-identity check — see the
 * two-candidate-class note at the top of this module.
 */
export async function resolveVerifiedRuntimeApiUrl(input: {
  configuredApiUrl: string;
  fallbackApiUrls: string[];
  /**
   * This process's own build commit, when it can read it. Every fallback has to
   * report the same one before it may receive spawned runs' credentials. Left
   * unset (or null) the fallbacks are accepted on the board health shape alone,
   * which is still narrower than the unconditional trust that preceded this
   * check.
   */
  selfCommit?: string | null;
  probe: RuntimeApiProbe;
}): Promise<RuntimeApiUrlResolution> {
  const configuredApiUrl = input.configuredApiUrl.trim();
  const selfCommit = input.selfCommit?.trim() || null;
  const rejected: Array<{ apiUrl: string; reason: string }> = [];
  const tried = new Set<string>();

  for (const [index, candidate] of [configuredApiUrl, ...input.fallbackApiUrls].entries()) {
    const apiUrl = candidate?.trim();
    if (!apiUrl || tried.has(apiUrl)) continue;
    tried.add(apiUrl);

    const isConfigured = index === 0;
    const result = await input.probe(apiUrl, {
      requireCommit: isConfigured ? null : selfCommit,
    });
    if (result.ok) {
      return { apiUrl, changed: apiUrl !== configuredApiUrl, rejected, unverified: false };
    }
    rejected.push({ apiUrl, reason: result.reason });
  }

  return { apiUrl: input.configuredApiUrl, changed: false, rejected, unverified: true };
}
