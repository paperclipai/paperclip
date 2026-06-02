/**
 * PostHog Query API client. Ported from agnb lib/integrations/posthog.ts.
 *
 * Runs HogQL queries against the project using a personal API key. Project ID
 * + host live in env. Differences from the agnb version:
 *   - Dropped `server-only` import and Next.js `next: { revalidate }` cache
 *     hints (no Next runtime here).
 *   - If POSTHOG_PROJECT_ID / POSTHOG_PERSONAL_API_KEY are missing, throws —
 *     callers (posthog-sync) wrap each query in Promise.allSettled so a
 *     missing key degrades that step gracefully.
 *
 * Docs: https://posthog.com/docs/api/query
 */
const HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
const PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
const PERSONAL_KEY = process.env.POSTHOG_PERSONAL_API_KEY;

async function hogql<T = unknown>(query: string): Promise<T[]> {
  if (!PROJECT_ID || !PERSONAL_KEY) {
    throw new Error("POSTHOG_PROJECT_ID or POSTHOG_PERSONAL_API_KEY not set.");
  }
  const res = await fetch(`${HOST}/api/projects/${PROJECT_ID}/query/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PERSONAL_KEY}`,
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`PostHog HTTP ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { results: unknown[][]; columns: string[] };
  const cols = json.columns ?? [];
  return (json.results ?? []).map((row) => {
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => {
      obj[c] = row[i];
    });
    return obj as T;
  });
}

export interface PageviewSource {
  source: string;
  views: number;
  unique_visitors: number;
}

/** Top traffic sources past N days (utm_source → referring domain → direct). */
export async function getTrafficSources(days = 30): Promise<PageviewSource[]> {
  const sql = `
    select
      coalesce(properties.utm_source, properties.$initial_referring_domain, 'direct') as source,
      count() as views,
      count(distinct distinct_id) as unique_visitors
    from events
    where event = '$pageview'
      and timestamp >= now() - interval ${days} day
    group by source
    order by views desc
    limit 20
  `;
  return hogql<PageviewSource>(sql);
}

export interface FunnelStep {
  step: string;
  count: number;
  conversion_pct: number;
}

/** Simple 3-step funnel: pageview → signin/signup → activation event. */
export async function getSignupFunnel(days = 30): Promise<FunnelStep[]> {
  const sql = `
    select
      'visitors' as step,
      count(distinct distinct_id) as count
    from events
    where timestamp >= now() - interval ${days} day
      and event = '$pageview'

    union all

    select
      'sign_up' as step,
      count(distinct distinct_id) as count
    from events
    where timestamp >= now() - interval ${days} day
      and event in ('user_signed_up', 'sign_up', '$identify')

    union all

    select
      'activated' as step,
      count(distinct distinct_id) as count
    from events
    where timestamp >= now() - interval ${days} day
      and event in ('finn_created', 'first_call_made')
  `;
  const rows = await hogql<{ step: string; count: number }>(sql);
  if (rows.length === 0) return [];
  const visitors = rows.find((r) => r.step === "visitors")?.count ?? 0;
  return rows.map((r) => ({
    step: r.step,
    count: Number(r.count),
    conversion_pct: visitors > 0 ? Math.round((Number(r.count) / visitors) * 100) : 0,
  }));
}

export interface TopPage {
  url: string;
  views: number;
  unique_visitors: number;
}

/** Top viewed pages past N days. */
export async function getTopPages(days = 30, limit = 25): Promise<TopPage[]> {
  const sql = `
    select
      properties.$pathname as url,
      count() as views,
      count(distinct distinct_id) as unique_visitors
    from events
    where event = '$pageview'
      and timestamp >= now() - interval ${days} day
      and properties.$pathname is not null
    group by url
    order by views desc
    limit ${limit}
  `;
  return hogql<TopPage>(sql);
}
