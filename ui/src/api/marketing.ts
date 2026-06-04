import { ported, unwrap } from "./agnbClient";

export type AssetStage =
  | "awareness"
  | "interest"
  | "evaluation"
  | "decision"
  | "onboard"
  | "retention";

/** Mirrors AGNB's AssetRow (app/.../marketing/asset-list.tsx). */
export interface AssetRow {
  id: string;
  title: string;
  stage: AssetStage;
  kind: string;
  status: "draft" | "active" | "archived";
  version: number;
  updated_at: string;
  created_by: string;
  html: string;
  variables?: string[] | null;
  notes?: string | null;
  fill_count?: number;
  last_fill_at?: string | null;
  last_fill_customer?: string | null;
  body_preview?: string;
}

export interface AssetFill {
  id: string;
  customer_name: string | null;
  created_at: string;
  created_by: string;
}

export interface AiFillResult {
  customer_name: string;
  values: Record<string, string>;
  filled: number;
  total: number;
  missing: string[];
}

export const marketingApi = {
  // Ported to All Gas No Brakes server — same-origin /api/agnb/marketing.
  /** GET /marketing?q= → asset list + fill stats. */
  list: (q?: string) =>
    ported<{ ok: boolean; assets: AssetRow[]; error?: string }>(
      `/marketing${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    ).then((r) => unwrap(r).assets),

  /** GET /marketing/:id → single asset + recent fills. */
  get: (id: string) =>
    ported<{ ok: boolean; error?: string; asset: AssetRow; fills: AssetFill[] }>(
      `/marketing/${encodeURIComponent(id)}`,
    ).then((r) => {
      const u = unwrap(r);
      return { asset: u.asset, fills: u.fills };
    }),

  /** POST /marketing → create. Returns new id. */
  create: (body: { title: string; stage: string; kind: string; html: string; status?: string; notes?: string | null }) =>
    ported<{ ok: boolean; id?: string; error?: string }>("/marketing", { method: "POST", body }).then((r) => unwrap(r).id!),

  /** PATCH /marketing?id= → edit (html/meta/status). */
  patch: (id: string, body: Record<string, unknown>) =>
    ported<{ ok: boolean; error?: string }>(`/marketing?id=${encodeURIComponent(id)}`, { method: "PATCH", body }).then((r) => unwrap(r)),

  /** POST /marketing/fill → record a fill. */
  fill: (body: { asset_id: string; customer_name?: string | null; variables_used?: Record<string, string>; html_rendered: string }) =>
    ported<{ ok: boolean; id?: string; error?: string }>("/marketing/fill", { method: "POST", body }).then((r) => unwrap(r).id!),
};
