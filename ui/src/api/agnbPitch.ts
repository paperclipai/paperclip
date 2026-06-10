import { ported, unwrap } from "./agnbClient";

/** Mirrors agnb.pitch_decks list rows. */
export interface PitchDeckRow {
  id: string;
  client_name: string;
  vertical: string | null;
  deck_title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PitchDeckDetail extends PitchDeckRow {
  slides: Array<{ id: string; [k: string]: unknown }>;
  answers: Record<string, string>;
}

/** Intake answers — keys match the ported generator (server/src/agnb/pitch/lib). */
export interface PitchAnswers {
  clientName: string;
  clientWebsite?: string;
  clientType: string;
  useCase: string;
  industry: string;
  region: string;
  format: string;
  length: string;
  primaryMetric?: string;
  monthlyCalls?: string;
  competitor?: string;
  stage: string;
  notes?: string;
}

export const agnbPitchApi = {
  /** GET /pitch → deck list (meta). */
  list: () =>
    ported<{ ok: boolean; decks: PitchDeckRow[]; error?: string }>("/pitch").then(
      (r) => unwrap(r).decks,
    ),

  /** GET /pitch/:id → deck meta + slides + answers. */
  get: (id: string) =>
    ported<{ ok: boolean; deck: PitchDeckDetail; error?: string }>(
      `/pitch/${encodeURIComponent(id)}`,
    ).then((r) => unwrap(r).deck),

  /** POST /pitch/generate → dev-only (claude CLI). Returns new id. */
  generate: (answers: PitchAnswers) =>
    ported<{ ok: boolean; id?: string; error?: string }>("/pitch/generate", {
      method: "POST",
      body: answers,
    }).then((r) => unwrap(r).id!),

  /** DELETE /pitch/:id. */
  remove: (id: string) =>
    ported<{ ok: boolean; error?: string }>(`/pitch/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).then((r) => unwrap(r)),

  /** Same-origin URL for the rendered deck HTML (iframe / new tab). */
  contentUrl: (id: string) => `/api/agnb/pitch/${encodeURIComponent(id)}/content`,

  /** Same-origin URL for the clean 16:9 PDF export (headless-Chrome, dev-only). */
  pdfUrl: (id: string) => `/api/agnb/pitch/${encodeURIComponent(id)}/pdf`,
};
