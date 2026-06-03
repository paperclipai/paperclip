import { agnb, unwrap } from "./agnbClient";

/**
 * Same-origin fetch for AGNB endpoints already ported into the All Gas No Brakes
 * server (under /api/agnb/*). As each route group migrates off the standalone
 * AGNB app, its client call moves here. See docs/migration/AGNB_CONSOLIDATION.md.
 */
async function ported<T>(path: string): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AGNB request failed: ${res.status}`);
  }
  return res.json();
}

/** Same-origin POST variant for ported AGNB write endpoints. */
async function portedPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errBody?.error ?? `AGNB request failed: ${res.status}`);
  }
  return res.json();
}

// ---- Forecast ----
export interface ForecastRow {
  bucket_id: string | null;
  bucket_name: string | null;
  weighted_forecast_usd: number;
  total_pipeline_usd: number;
  deals_in_pipeline: number;
  deals_won: number;
  won_revenue_usd: number;
  ci_p5: number | null;
  ci_p50: number | null;
  ci_p95: number | null;
}
export interface ForecastResp {
  totals: { weighted: number; total: number; won: number; deals: number };
  global_ci: { p5: number; p50: number; p95: number } | null;
  forecast: ForecastRow[];
  note: string | null;
}

// ---- Demos ----
export interface DemoRow {
  id: string;
  uid: string | null;
  title: string | null;
  status: string | null;
  start_at: string | null;
  end_at: string | null;
  attendee_email: string | null;
  attendee_name: string | null;
  event_type_slug: string | null;
}

// ---- Channels ----
export interface ChannelRow {
  channel: string;
  color: string;
  meetings: number;
  wins: number;
  losses: number;
  revenue_usd: number;
  win_rate: number;
}

// ---- Attribution ----
export interface UnmatchedEvent {
  id: string;
  source: string;
  event_type: string;
  email: string | null;
  contact_name: string | null;
  amount_usd: number | null;
  occurred_at: string;
  match_method: string | null;
}

// ---- Funnel ----
export interface FunnelStep {
  step: string;
  count: number;
  conversion_pct: number;
}
export interface PageviewSource { source: string; views: number; unique_visitors: number }
export interface TopPage { url: string; views: number; unique_visitors: number }

// ---- CRM hygiene ----
export interface HygieneIssue {
  id: string;
  hubspot_object_type: string;
  hubspot_object_id: string;
  hubspot_object_name: string | null;
  issue_type: string;
  severity: string;
  details: string | null;
  detected_at: string;
  resolved_at: string | null;
}

// ---- Win/loss ----
export interface Interview {
  id: string;
  deal_id: string | null;
  customer_name: string;
  outcome: string;
  interview_date: string;
  contact_name: string | null;
  contact_title: string | null;
  summary: string | null;
  top_reasons: string[] | null;
  decision_makers?: string[] | null;
  competitors_considered: string[] | null;
  feature_requests?: string[] | null;
  raw_quote?: string | null;
  raw_transcript?: string | null;
  tags: string[] | null;
  analysis_status: string;
  created_at: string;
}

export interface RematchSuggestion {
  event_id: string;
  bucket_id: string | null;
  confidence: number;
  reason: string;
}

// ---- Invoices ----
export interface InvoiceRow {
  id: string;
  invoice_number: string | null;
  short_url: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_state: string | null;
  amount_paise: number;
  subtotal_paise: number | null;
  gst_paise: number | null;
  total_paise: number | null;
  status: string;
  paid_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
}

export const agnbPagesApi = {
  // Ported to All Gas No Brakes server (group: revenue) — same-origin /api/agnb/forecast.
  forecast: () =>
    ported<{ ok: boolean; error?: string } & ForecastResp>("/forecast").then((r) => unwrap(r)),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/demos.
  demos: () =>
    ported<{ ok: boolean; error?: string; upcoming: DemoRow[]; past: DemoRow[] }>("/demos")
      .then((r) => unwrap(r)),
  // /channels not yet ported — external (left cross-origin).
  channels: (days = 90) =>
    agnb
      .get<{ ok: boolean; error?: string; days: number; channels: ChannelRow[] }>(`/channels?days=${days}`)
      .then((r) => unwrap(r)),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/attribution.
  attribution: () =>
    ported<{ ok: boolean; error?: string; matched: number; unmatched: number; recent_unmatched: UnmatchedEvent[] }>("/attribution")
      .then((r) => unwrap(r)),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/funnel.
  funnel: () =>
    ported<{ ok: boolean; error?: string; snapshot_date: string | null; steps: FunnelStep[]; sources?: PageviewSource[]; pages?: TopPage[] }>("/funnel")
      .then((r) => unwrap(r)),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/crm-hygiene.
  crmHygiene: () =>
    ported<{ ok: boolean; error?: string; issues: HygieneIssue[] }>("/crm-hygiene")
      .then((r) => unwrap(r).issues),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/win-loss (GET read).
  winLoss: (outcome = "all") =>
    ported<{ ok: boolean; error?: string; interviews: Interview[] }>(`/win-loss${outcome !== "all" ? `?outcome=${outcome}` : ""}`)
      .then((r) => unwrap(r).interviews),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/invoices (GET read).
  invoices: () =>
    ported<{ ok: boolean; error?: string; invoices: InvoiceRow[] }>("/invoices")
      .then((r) => unwrap(r).invoices),
  createInvoice: (body: {
    customer_name: string;
    customer_email?: string;
    customer_phone?: string;
    customer_gstin?: string;
    customer_state?: string;
    subtotal_inr: number;
    plan_tier?: string;
    description?: string;
  }) =>
    agnb
      .post<{ ok: boolean; error?: string; row?: InvoiceRow; rzp?: { short_url?: string } }>("/invoices/create", body)
      .then((r) => unwrap(r)),

  // --- Win/loss write actions ---
  winLossCreate: (body: { customer_name: string; outcome: string; interview_date: string; contact_name?: string; contact_title?: string; raw_transcript?: string }) =>
    agnb.post<{ ok: boolean; error?: string; row?: Interview }>("/win-loss", body).then((r) => unwrap(r)),
  winLossAnalyze: (id: string) =>
    agnb.post<{ ok: boolean; error?: string; analysis?: Record<string, unknown> }>(`/win-loss/${encodeURIComponent(id)}/analyze`, {}).then((r) => unwrap(r)),
  winLossDelete: (id: string) =>
    agnb.delete<{ ok: boolean; error?: string }>(`/win-loss?id=${encodeURIComponent(id)}`),

  // --- Attribution Gemini rematch (LLM) — stays cross-origin (Phase 5). ---
  attributionRematch: (apply: boolean, limit = 25) =>
    agnb
      .post<{ ok: boolean; error?: string; suggestions: RematchSuggestion[]; applied?: number; note?: string }>("/attribution/gemini-rematch", { apply, limit })
      .then((r) => unwrap(r)),
  // Non-LLM email→bucket rematch. Ported to All Gas No Brakes server (group: revenue)
  // — same-origin POST /api/agnb/attribution/rematch. Pure DB.
  attributionRematchDb: () =>
    portedPost<{ ok: boolean; error?: string; scanned: number; matched: number }>("/attribution/rematch")
      .then((r) => unwrap(r)),

  // --- CRM hygiene manual scan ---
  crmScan: () =>
    agnb.post<{ ok: boolean; error?: string }>("/crons/run?path=/all-gas-no-brakes/api/internal/crm-hygiene-scan", {}),
};
