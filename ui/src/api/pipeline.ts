import { agnb, unwrap } from "./agnbClient";

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
  /** POST /pipeline/move — change a deal's stage (write action, used later). */
  move: (deal_id: string, stage_id: string, lost_reason?: string) =>
    agnb.post<{ ok: boolean; error?: string }>("/pipeline/move", {
      deal_id,
      stage_id,
      ...(lost_reason ? { lost_reason } : {}),
    }),
};
