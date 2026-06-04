import { ported, unwrap } from "./agnbClient";

export interface CsvUpload {
  id: string; filename: string; rows_total: number | null; rows_kept: number | null; rows_dedup: number | null; rows_suppressed: number | null; status: string; rocket_file_id: string | null; uploaded_at: string;
}
export interface SubjectLine {
  id: string; subject: string; first_word: string | null; length_chars: number | null; campaign_name: string | null; sends: number; opens: number; replies: number; open_rate: number | null; reply_rate: number | null; pattern_tags: string[] | null; created_at: string;
}
export interface Experiment {
  id: string; title: string; hypothesis: string; metric: string; outcome: string | null; started_at: string; ended_at: string | null; created_by: string; verdict: string | null; p_b_beats_a: number | null; variant_a_sent: number; variant_b_sent: number; variant_a_replies: number; variant_b_replies: number;
}
export interface CohortSnapshot { bucket_id: string; snapshot_date: string; total_sent: number; total_positive: number }
export interface CohortBucket { id: string; icp_id: string | null }
export interface CohortIcp { id: string; name: string; tier: string }

export const experimentsApi = {
  // Ported to All Gas No Brakes server — same-origin /api/agnb/csv.
  csv: () => ported<{ ok: boolean; error?: string; uploads: CsvUpload[] }>("/csv").then((r) => unwrap(r).uploads),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/subjects.
  subjects: () => ported<{ ok: boolean; error?: string; subjects: SubjectLine[] }>("/subjects").then((r) => unwrap(r).subjects),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/experiments.
  experiments: () => ported<{ ok: boolean; error?: string; experiments: Experiment[] }>("/experiments").then((r) => unwrap(r).experiments),
  // Ported to All Gas No Brakes server — same-origin /api/agnb/cohorts.
  cohorts: () => ported<{ ok: boolean; error?: string; snapshots: CohortSnapshot[]; buckets: CohortBucket[]; icps: CohortIcp[] }>("/cohorts").then((r) => unwrap(r)),
};
