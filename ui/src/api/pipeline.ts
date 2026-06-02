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

/** Mirrors AGNB's Card (app/.../pipeline/pipeline-board.tsx). */
export interface PipelineCard {
  id: string;
  name: string;
  amount: number;
  ownerName: string;
  closeAt: string | null;
  createdAt: string | null;
  source: string | null;
  hubspotUrl: string;
  stageLabel: string;
  probability?: number | null;
  commentCount?: number;
  description?: string | null;
  priority?: string | null;
  nextStep?: string | null;
  lastContactedAt?: string | null;
  nextActivityAt?: string | null;
  numNotes?: number;
  numContactedNotes?: number;
  numAssociatedContacts?: number;
  lifecycleStage?: string | null;
  forecastAmount?: number | null;
  forecastProbability?: number | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  closedLostReason?: string | null;
  closedWonReason?: string | null;
  wasImported?: boolean;
  contacts?: Array<{ id: string; name: string; email?: string; jobtitle?: string }>;
  company?: {
    id: string;
    name?: string;
    domain?: string;
    industry?: string;
    employees?: string;
  } | null;
}

export interface PipelineColumn {
  id: string;
  label: string;
  cards: PipelineCard[];
}

export interface FunnelStage {
  stageId: string;
  label: string;
  count: number;
  amount: number;
  reachedPct: number;
}

export interface PipelineBoard {
  columns: PipelineColumn[];
  funnel: FunnelStage[];
  lastSync: string | null;
  errors: string[];
}

export const pipelineApi = {
  // PHASE 5: GET /pipeline (loadPipelineBoard) reads live HubSpot deals/
  // pipelines/owners/contacts + funnel — external CRM, left cross-origin.
  /** GET /pipeline → kanban board (columns + cards), funnel, last sync. */
  board: () =>
    agnb
      .get<{ ok: boolean; error?: string } & PipelineBoard>("/pipeline")
      .then((r) => {
        const u = unwrap(r);
        return {
          columns: u.columns,
          funnel: u.funnel,
          lastSync: u.lastSync,
          errors: u.errors,
        } as PipelineBoard;
      }),
  // PHASE 5: POST /pipeline/move calls HubSpot updateDealStage — cross-origin.
  /** POST /pipeline/move — change a deal's stage. */
  move: (deal_id: string, stage_id: string, lost_reason?: string) =>
    agnb.post<{ ok: boolean; error?: string }>("/pipeline/move", {
      deal_id,
      stage_id,
      ...(lost_reason ? { lost_reason } : {}),
    }),
  // PHASE 5: POST /pipeline/create calls HubSpot createDeal — cross-origin.
  /** POST /pipeline/create — new deal in a stage. */
  createDeal: (body: { dealname: string; dealstage: string; amount?: number; closedate?: string }) =>
    agnb.post<{ ok: boolean; error?: string }>("/pipeline/create", body),

  // Ported to Paperclip server — same-origin /api/agnb/pipeline/comments.
  comments: (dealId: string) =>
    ported<{ ok: boolean; error?: string; comments: PipelineComment[] }>(`/pipeline/comments?deal_id=${dealId}`).then((r) => unwrap(r).comments),
  addComment: (deal_id: string, body: string) =>
    ported<{ ok: boolean; error?: string; comment: PipelineComment }>("/pipeline/comments", { method: "POST", body: { deal_id, body } }).then((r) => unwrap(r).comment),
  deleteComment: (id: string) =>
    ported<{ ok: boolean; error?: string }>(`/pipeline/comments?id=${id}`, { method: "DELETE" }),

  // PHASE 5: GET/PATCH /pipeline/tasks are HubSpot task reads/writes — cross-origin.
  tasks: (dealId: string) =>
    agnb.get<{ ok: boolean; error?: string; tasks: PipelineTask[] }>(`/pipeline/tasks?deal_id=${dealId}`).then((r) => unwrap(r).tasks),
  toggleTask: (task_id: string, status: "COMPLETED" | "NOT_STARTED") =>
    agnb.patch<{ ok: boolean; error?: string }>("/pipeline/tasks", { task_id, status }),

  // Ported to Paperclip server — same-origin /api/agnb/pipeline/activity.
  // NOTE: server feed is comments-only (pipeline_move_log not yet migrated).
  activity: (dealId: string) =>
    ported<{ ok: boolean; error?: string; activity: ActivityItem[] }>(`/pipeline/activity?deal_id=${dealId}`).then((r) => unwrap(r).activity),

  // PHASE 5: GET /pipeline/details reads HubSpot line items/quotes/tickets — cross-origin.
  details: (dealId: string) =>
    agnb.get<{ ok: boolean; error?: string } & DealDetails>(`/pipeline/details?deal_id=${dealId}`).then((r) => {
      const u = unwrap(r);
      return { lineItems: u.lineItems, quotes: u.quotes, tickets: u.tickets } as DealDetails;
    }),
};

export interface PipelineComment {
  id: string;
  deal_id: string;
  author: string;
  body: string;
  created_at: string;
}
export interface PipelineTask {
  id: string;
  subject: string;
  status: "COMPLETED" | "NOT_STARTED" | string;
  body?: string;
  dueAt?: string;
}
export interface ActivityItem {
  kind: "move" | "comment" | "engagement";
  id: string;
  at: string;
  by: string;
  body: string;
  subkind?: string;
}
export interface DealDetails {
  lineItems: Array<{ id: string; name: string; quantity: number; price: number; amount: number }>;
  quotes: Array<{ id: string; title: string; status: string; amount: number }>;
  tickets: Array<{ id: string; subject: string; stage: string; priority?: string }>;
}
