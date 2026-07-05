import { api } from "./client";

// cps.decompose_event.v1 — one processing-step event streamed by the engine.
export interface DecomposeEvent {
  run_id?: string;
  seq: number;
  ts: string;
  step: string;
  status: "start" | "progress" | "ok" | "warn" | "blocked" | "error" | "done" | "info" | string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface DecomposeRunSummary {
  runId: string;
  title: string;
  verdict: string | null;
  running: boolean;
  hasReport: boolean;
}

export const decomposeApi = {
  start: (form: FormData) => api.postForm<{ runId: string }>("/decompose/runs", form),
  runs: () => api.get<{ runs: DecomposeRunSummary[] }>("/decompose/runs"),
  events: (runId: string, offset: number) =>
    api.get<{ events: DecomposeEvent[]; done: boolean; running: boolean }>(
      `/decompose/runs/${encodeURIComponent(runId)}/events?offset=${offset}`,
    ),
  reportUrl: (runId: string) => `/api/decompose/runs/${encodeURIComponent(runId)}/report`,
};
