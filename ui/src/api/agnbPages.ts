import { ported, unwrap } from "./agnbClient";

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
  // Read-only deal board from the agnb.hubspot_deals mirror (Sales-Ops Analyst keeps it current).
  pipelineBoard: () =>
    ported<{ ok: boolean; error?: string; columns: PipelineColumn[] }>("/pipeline/board")
      .then((r) => unwrap(r).columns),
};

export interface PipelineCard { id: string; name: string; amount: number; closeDate: string | null }
export interface PipelineColumn { id: string; label: string; cards: PipelineCard[]; total: number }
