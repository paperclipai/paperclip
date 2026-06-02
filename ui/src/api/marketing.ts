import { agnb, unwrap } from "./agnbClient";

/**
 * Same-origin fetch for AGNB endpoints already ported into the Paperclip
 * server (under /api/agnb/*). As each route group migrates off the standalone
 * AGNB app, its client call moves here. See docs/migration/AGNB_CONSOLIDATION.md.
 */
async function ported<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/agnb${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `AGNB request failed: ${res.status}`);
  }
  return res.json();
}

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
  // Ported to Paperclip server — same-origin /api/agnb/marketing.
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

  // PHASE 5: Gemini/LLM + PDF render — external, left cross-origin.
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
