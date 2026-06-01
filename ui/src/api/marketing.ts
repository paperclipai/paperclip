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

export const marketingApi = {
  /** GET /marketing?q= → asset list + fill stats. */
  list: (q?: string) =>
    agnb
      .get<{ ok: boolean; assets: AssetRow[]; error?: string }>(
        `/marketing${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      )
      .then((r) => unwrap(r).assets),
};
