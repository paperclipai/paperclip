import type {
  RecordResponsibilityMetricReading,
  ResponsibilityMetricDisplay,
  ResponsibilityMetricSet,
  SetResponsibilityMetrics,
} from "@paperclipai/shared";
import { api } from "./client";

export interface RecordedMetricReading {
  reading: {
    /** `primary`, or the supporting metric's id. */
    metric: string | null;
    value: number;
    recordedAt: string;
    corrected: boolean;
    /** False when an older reading joined the history without changing the bar's reading. */
    current: boolean;
  };
}

/** A responsibility's metric set (experimental `enableResponsibilities`). */
export const responsibilityMetricsApi = {
  /** Up to three metrics ready to draw: the bar's own first, then chosen supporting ones or starters. */
  metrics: (responsibilityId: string) =>
    api.get<ResponsibilityMetricSet>(`/responsibilities/${encodeURIComponent(responsibilityId)}/metrics`),
  /** The owner sets the supporting metrics (replacing any). */
  setMetrics: (responsibilityId: string, body: SetResponsibilityMetrics) =>
    api.put<ResponsibilityMetricSet>(`/responsibilities/${encodeURIComponent(responsibilityId)}/metrics`, body),
  /** The owner removes one supporting metric; returns the set as it is after. */
  removeMetric: (responsibilityId: string, metricId: string) =>
    api.delete<ResponsibilityMetricSet>(
      `/responsibilities/${encodeURIComponent(responsibilityId)}/metrics/${encodeURIComponent(metricId)}`,
    ),
  /** The owner switches how one metric is drawn (`metricRef`: a supporting metric's id, or `primary`); returns the set as it is after. */
  setDisplay: (responsibilityId: string, metricRef: string, display: ResponsibilityMetricDisplay) =>
    api.patch<ResponsibilityMetricSet>(
      `/responsibilities/${encodeURIComponent(responsibilityId)}/metrics/${encodeURIComponent(metricRef)}`,
      { display },
    ),
  /** `metricRef` is a supporting metric's id, or `primary` for the bar's own metric. */
  recordReading: (responsibilityId: string, metricRef: string, body: RecordResponsibilityMetricReading) =>
    api.post<RecordedMetricReading>(
      `/responsibilities/${encodeURIComponent(responsibilityId)}/metrics/${encodeURIComponent(metricRef)}/readings`,
      body,
    ),
};
