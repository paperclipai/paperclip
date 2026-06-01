import { agnb, unwrap } from "./agnbClient";

export interface Campaign {
  id: string;
  name: string | null;
  status: string | null;
  type: string | null;
  framework: string | null;
  sent_count: number | null;
  open_count: number | null;
  reply_count: number | null;
  meeting_count: number | null;
  open_rate: number | null;
  reply_rate: number | null;
  meeting_rate: number | null;
}
export interface Sender { id: string; email: string; sender_type: string | null; status: string | null }

export interface SavedTargeting {
  id: string;
  name: string;
  query: string;
  notes: string | null;
  tags: string[] | null;
  last_run_at: string | null;
  last_lead_count: number | null;
  created_at: string;
  created_by: string;
}

export interface Persona { id: string; name: string; title: string | null }
export interface Product { id: string; name: string; description: string | null }

export interface JustdialJob {
  id: string;
  category: string;
  city: string;
  max_pages: number;
  status: string;
  error: string | null;
  pages_scraped: number | null;
  leads_count: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface LinkedinProfile {
  id: string;
  source_url: string;
  full_name: string | null;
  headline: string | null;
  location: string | null;
  current_company: string | null;
  current_title: string | null;
  photo_url: string | null;
  scraped_at: string | null;
  added_at: string;
}

export interface BucketRow {
  id: string;
  name: string;
  icp_id: string | null;
  icp_name: string | null;
  status: string;
  target_reply_rate: number | null;
  estimated_leads: number | null;
  created_at: string;
  rollup: {
    total_sent: number;
    total_replies: number;
    total_positive: number;
    total_meetings: number;
    compound_reply_rate: number | null;
    compound_positive_rate: number | null;
    campaigns_run: number;
  } | null;
}

export interface IcpRow {
  id: string;
  name: string;
  industries: string[] | null;
  company_size_min: number | null;
  company_size_max: number | null;
  regions: string[] | null;
  functions: string[] | null;
  seniority: string[] | null;
  tier: "now" | "later" | "monitor" | string;
  created_at: string;
}

export const campaignsApi = {
  campaigns: () =>
    agnb.get<{ ok: boolean; error?: string; campaigns: Campaign[]; senders: Sender[] }>("/campaigns").then((r) => unwrap(r)),
  targeting: () =>
    agnb.get<{ ok: boolean; error?: string; targetings: SavedTargeting[] }>("/targeting").then((r) => unwrap(r).targetings),
  personas: () =>
    agnb.get<{ ok: boolean; error?: string; personas: Persona[] }>("/studio/personas").then((r) => unwrap(r).personas),
  products: () =>
    agnb.get<{ ok: boolean; error?: string; products: Product[] }>("/studio/products").then((r) => unwrap(r).products),
  justdial: () =>
    agnb.get<{ ok: boolean; error?: string; jobs: JustdialJob[] }>("/leads/justdial").then((r) => unwrap(r).jobs),
  linkedin: () =>
    agnb.get<{ ok: boolean; error?: string; profiles: LinkedinProfile[] }>("/linkedin").then((r) => unwrap(r).profiles),
  buckets: () =>
    agnb.get<{ ok: boolean; error?: string; buckets: BucketRow[] }>("/buckets").then((r) => unwrap(r).buckets),
  icps: () =>
    agnb.get<{ ok: boolean; error?: string; icps: IcpRow[] }>("/icps").then((r) => unwrap(r).icps),

  // --- write actions ---
  createPersona: (body: { name: string; title?: string; description?: string }) =>
    agnb.post<{ ok: boolean; error?: string }>("/rocket/personas/create", body).then((r) => unwrap(r)),
  createProduct: (body: { name: string; description?: string }) =>
    agnb.post<{ ok: boolean; error?: string }>("/rocket/products/create", body).then((r) => unwrap(r)),
  createIcp: (body: { name: string; tier: string; industries: string[]; regions: string[]; functions: string[]; company_size_min?: number | null; company_size_max?: number | null }) =>
    agnb.post<{ ok: boolean; error?: string }>("/icps", body).then((r) => unwrap(r)),
  saveTargeting: (body: { name: string; query: string; notes?: string; tags?: string[] }) =>
    agnb.post<{ ok: boolean; error?: string }>("/targeting", body).then((r) => unwrap(r)),
  queueJustdial: (body: { category: string; city: string; max_pages: number }) =>
    agnb.post<{ ok: boolean; error?: string }>("/leads/justdial", body).then((r) => unwrap(r)),
  runJustdial: (id: string) =>
    agnb.post<{ ok: boolean; error?: string }>(`/leads/justdial/run?id=${encodeURIComponent(id)}`, {}),
  scrapeLinkedin: (url: string) =>
    agnb.post<{ ok: boolean; error?: string }>("/linkedin/scrape", { url }).then((r) => unwrap(r)),
  syncLinkedin: () =>
    agnb.post<{ ok: boolean; error?: string }>("/linkedin/sync", {}),
  createBucket: (body: { name: string; icp_id?: string | null; target_reply_rate?: number }) =>
    agnb.post<{ ok: boolean; error?: string }>("/buckets", body).then((r) => unwrap(r)),
};
