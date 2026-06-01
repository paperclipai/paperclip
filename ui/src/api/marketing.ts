import { agnb, unwrap } from "./agnbClient";

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

const AGNB_BASE = (
  (import.meta.env.VITE_AGNB_BASE_URL as string | undefined) ??
  "https://www.allgasnobrakes.online"
).replace(/\/$/, "");

export const marketingApi = {
  /** GET /marketing?q= → asset list + fill stats. */
  list: (q?: string) =>
    agnb
      .get<{ ok: boolean; assets: AssetRow[]; error?: string }>(
        `/marketing${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      )
      .then((r) => unwrap(r).assets),

  /** GET /marketing/:id → single asset + recent fills. */
  get: (id: string) =>
    agnb
      .get<{ ok: boolean; error?: string; asset: AssetRow; fills: AssetFill[] }>(
        `/marketing/${encodeURIComponent(id)}`,
      )
      .then((r) => {
        const u = unwrap(r);
        return { asset: u.asset, fills: u.fills };
      }),

  /** POST /marketing → create. Returns new id. */
  create: (body: { title: string; stage: string; kind: string; html: string; status?: string; notes?: string | null }) =>
    agnb.post<{ ok: boolean; id?: string; error?: string }>("/marketing", body).then((r) => unwrap(r).id!),

  /** PATCH /marketing?id= → edit (html/meta/status). */
  patch: (id: string, body: Record<string, unknown>) =>
    agnb.patch<{ ok: boolean; error?: string }>(`/marketing?id=${encodeURIComponent(id)}`, body).then((r) => unwrap(r)),

  /** POST /marketing/fill → record a fill. */
  fill: (body: { asset_id: string; customer_name?: string | null; variables_used?: Record<string, string>; html_rendered: string }) =>
    agnb.post<{ ok: boolean; id?: string; error?: string }>("/marketing/fill", body).then((r) => unwrap(r).id!),

  /** POST /marketing/:id/ai-fill → Gemini extracts values from free text. */
  aiFill: (id: string, prompt: string) =>
    agnb
      .post<{ ok: boolean; error?: string } & AiFillResult>(`/marketing/${encodeURIComponent(id)}/ai-fill`, { prompt })
      .then((r) => unwrap(r) as AiFillResult),

  /** POST /marketing/pdf → returns a PDF blob. */
  pdf: async (html: string, filename: string): Promise<Blob> => {
    const res = await fetch(`${AGNB_BASE}/all-gas-no-brakes/api/agnb/marketing/pdf`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, filename }),
    });
    if (!res.ok) throw new Error(`PDF failed: ${res.status}`);
    return res.blob();
  },
};
