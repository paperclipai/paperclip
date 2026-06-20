/**
 * Production health gate for incident closure.
 *
 * Blocks a production-incident issue from transitioning into a closed status
 * ("done") unless the configured production URLs actually return HTTP 200. This
 * replaces "the board approved it" with an automated check against live
 * production — a P0 was approved-closed three times while production was still
 * down (every deploy BLOCKED / behind a 401 protection wall).
 *
 * Fail-open by design when UNCONFIGURED: if no targets are set, the gate is a
 * no-op so it can never block unrelated issue closures. It only enforces once
 * PRODUCTION_HEALTH_TARGETS is provided.
 */

export type ProductionHealthTarget = {
  name: string;
  url: string;
  expectStatus?: number;
  bodyIncludes?: string;
};

export type ProductionHealthResult = {
  name: string;
  url: string;
  healthy: boolean;
  status: number;
  reason?: string;
};

export class ProductionHealthGateError extends Error {
  readonly results: ProductionHealthResult[];
  constructor(results: ProductionHealthResult[]) {
    const failed = results.filter((r) => !r.healthy);
    super(
      `Production health gate failed: ${failed.length}/${results.length} target(s) not healthy ` +
        `(${failed.map((r) => `${r.name}=${r.status}`).join(", ")}). ` +
        `Resolve production before closing this incident.`,
    );
    this.name = "ProductionHealthGateError";
    this.results = results;
  }
}

const DEFAULT_EXPECT_STATUS = 200;
// Keep the total retry budget well under the ~30s where most HTTP clients,
// ALBs, and nginx proxies cut the connection — otherwise an activated gate
// holds the PATCH handler long enough that the caller sees a network timeout
// instead of the intended 409. Worst case here: 2 * 5s timeout + 1 * 1s delay = 11s.
const DEFAULT_RETRIES = 2;
const DEFAULT_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 5000;

/** Parse PRODUCTION_HEALTH_TARGETS (JSON: array or {targets:[...]}). Empty = gate disabled. */
export function getProductionHealthTargets(env: NodeJS.ProcessEnv = process.env): ProductionHealthTarget[] {
  const raw = env.PRODUCTION_HEALTH_TARGETS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { targets?: unknown }).targets)
      ? (parsed as { targets: unknown[] }).targets
      : [];
  return list
    .map((item): ProductionHealthTarget | null => {
      const t = item as Record<string, unknown>;
      const expect = (t.expect as Record<string, unknown> | undefined) ?? {};
      if (typeof t.url !== "string" || !t.url) return null;
      return {
        name: typeof t.name === "string" ? t.name : t.url,
        url: t.url,
        expectStatus: typeof expect.status === "number" ? expect.status : undefined,
        bodyIncludes: typeof expect.bodyIncludes === "string" ? expect.bodyIncludes : undefined,
      };
    })
    .filter((t): t is ProductionHealthTarget => t !== null);
}

/** Issue is a production incident when a configured marker appears in its labels or title. */
export function isProductionIncidentIssue(
  issue: { title?: string | null; labels?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const markers = (env.PRODUCTION_INCIDENT_MARKERS ?? "production,p0,incident,outage")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  if (markers.length === 0) return false;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const haystack = [
    issue.title ?? "",
    ...labels.map((l) => (typeof l === "string" ? l : ((l as { name?: string })?.name ?? ""))),
  ]
    .join(" ")
    .toLowerCase();
  return markers.some((m) => haystack.includes(m));
}

async function probe(target: ProductionHealthTarget): Promise<ProductionHealthResult> {
  const expectStatus = target.expectStatus ?? DEFAULT_EXPECT_STATUS;
  let lastStatus = 0;
  let lastReason: string | undefined;
  for (let attempt = 1; attempt <= DEFAULT_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      // Follow redirects and judge the final settled status. With redirect:"manual",
      // undici returns an opaque response whose status is always 0, so a target that
      // does any redirect (http->https, trailing-slash, etc.) would never match the
      // expected 200 and the gate would block every closure on a healthy endpoint.
      const res = await fetch(target.url, { redirect: "follow", signal: controller.signal });
      const body = target.bodyIncludes ? await res.text().catch(() => "") : "";
      const statusOk = res.status === expectStatus;
      const bodyOk =
        !target.bodyIncludes || body.toLowerCase().includes(target.bodyIncludes.toLowerCase());
      lastStatus = res.status;
      if (statusOk && bodyOk) {
        return { name: target.name, url: target.url, healthy: true, status: res.status };
      }
      lastReason = !statusOk
        ? `got ${res.status}, expected ${expectStatus}`
        : `body missing "${target.bodyIncludes}"`;
    } catch (err) {
      lastStatus = 0;
      lastReason = err instanceof Error && err.name === "AbortError" ? "timeout" : String(err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < DEFAULT_RETRIES) await new Promise((r) => setTimeout(r, DEFAULT_DELAY_MS));
  }
  return { name: target.name, url: target.url, healthy: false, status: lastStatus, reason: lastReason };
}

/**
 * Throw {@link ProductionHealthGateError} if a production incident is being closed
 * while production is unhealthy. No-op when the gate is unconfigured, the issue is
 * not a production incident, or the transition is not into a closed status.
 */
export async function assertProductionHealthyForClosure(input: {
  issue: { title?: string | null; labels?: unknown };
  existingStatus: string | null | undefined;
  requestedStatus: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  probeFn?: (t: ProductionHealthTarget) => Promise<ProductionHealthResult>;
}): Promise<void> {
  const env = input.env ?? process.env;
  const closing = input.requestedStatus === "done" && input.existingStatus !== "done";
  if (!closing) return;
  if (!isProductionIncidentIssue(input.issue, env)) return;
  const targets = getProductionHealthTargets(env);
  if (targets.length === 0) return; // gate disabled / unconfigured

  const probeFn = input.probeFn ?? probe;
  const results = await Promise.all(targets.map((t) => probeFn(t)));
  if (results.some((r) => !r.healthy)) {
    throw new ProductionHealthGateError(results);
  }
}
