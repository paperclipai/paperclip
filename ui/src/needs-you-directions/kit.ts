import type { FC } from "react";
import type { AttentionSeverity, AttentionSourceKind, AttentionStaleReason, AttentionViewCounts } from "@paperclipai/shared";
import { registry } from "./registry";

export type DirectionId = (typeof registry.directions)[number]["id"];
export type SurfaceId = (typeof registry.surfaces)[number]["id"];

export type LabKind =
  | "plan"
  | "confirmation"
  | "question"
  | "suggested_tasks"
  | "decision"
  | "budget"
  | "failed_run"
  | "approval"
  | "review"
  | "blocker"
  | "recovery"
  | "join_request"
  | "agent_error";

export interface LabQuestion {
  prompt: string;
  mode: "single" | "multi" | "text";
  options?: string[];
  recommended?: string;
  help?: string;
}

export interface LabSpend {
  spent: string;
  limit: string;
  percent: number;
}

export interface LabTarget {
  kind: "plan" | "attachment" | "approval";
  label: string;
}

export interface LabAttentionRecord {
  id: string;
  kind: LabKind;
  decideHere: boolean;
  source: AttentionSourceKind;
  task: string;
  taskTitle: string;
  agent: string;
  ageLabel: string;
  severity: AttentionSeverity;
  ask: string;
  context: string;
  reason: string;
  forUser?: string;
  unowned?: boolean;
  stale?: AttentionStaleReason;
  primary: string;
  secondary?: string[];
  target?: LabTarget;
  questions?: LabQuestion[];
  suggested?: string[];
  options?: string[];
  spend?: LabSpend;
  error?: string;
  blockingTask?: { identifier: string; title: string };
}

export interface LabReceipt {
  id: string;
  line: string;
  title: string;
  task: string;
  ageLabel: string;
}

export interface LabHistoryRecord {
  id: string;
  line: string;
  title: string;
  task: string;
  ageLabel: string;
  outcome: "approved" | "answered" | "withdrawn" | "expired" | "rejected";
}

export interface LandingData {
  records: LabAttentionRecord[];
  receipts: LabReceipt[];
  counts: AttentionViewCounts;
}

export interface CardData {
  records: LabAttentionRecord[];
}

export interface PanelData {
  record: LabAttentionRecord;
  history: LabHistoryRecord[];
}

export interface SurfaceData extends Record<SurfaceId, unknown> {
  landing: LandingData;
  card: CardData;
  panel: PanelData;
}

export interface DirectionKit {
  id: DirectionId;
  name: string;
  tagline: string;
  flags?: Record<string, boolean>;
  LandingBody: FC<SurfaceData["landing"]>;
  CardBody: FC<SurfaceData["card"]>;
  PanelBody: FC<SurfaceData["panel"]>;
}

export const DIRECTION_IDS: readonly DirectionId[] = registry.directions.map((direction) => direction.id);
export const SURFACE_IDS: readonly SurfaceId[] = registry.surfaces.map((surface) => surface.id);

export const KIT_KEYS = Object.fromEntries(registry.directions.map((direction) => [direction.id, direction.key])) as Record<DirectionId, string>;
export const KIT_META = Object.fromEntries(registry.directions.map((direction) => [direction.id, { name: direction.name, tagline: direction.tagline }])) as Record<
  DirectionId,
  { name: string; tagline: string }
>;

export function surfaceOf(id: SurfaceId) {
  const surface = registry.surfaces.find((entry) => entry.id === id);
  if (!surface) throw new Error(`No surface ${id} in the needs-you registry`);
  return surface;
}

const KIT_LOADERS = import.meta.glob<{ kit: DirectionKit }>("./directions/*/index.tsx");

export function loadKit(id: DirectionId): Promise<DirectionKit> {
  const load = KIT_LOADERS[`./directions/${id}/index.tsx`];
  if (!load) return Promise.reject(new Error(`No kit at directions/${id}/index.tsx`));
  return load().then((module) => module.kit);
}
