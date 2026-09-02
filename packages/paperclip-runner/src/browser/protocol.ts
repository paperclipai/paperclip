import type { PrpEvent } from "../protocol/replay-contract.js";
import type { SessionSnapshot } from "../reducer/session-reducer.js";

/**
 * The browser only ever sees the demo server's public state and the canonical
 * PRP event stream. There is no second event model and no client-side session
 * cache: every surface reads these shapes or the reducer snapshot they carry.
 */
export interface RunnerCapabilities {
  resume: boolean;
  typedEvents: boolean;
  steering: boolean;
  interruption: boolean;
  structuredResult: boolean;
  read?: boolean;
  reconciliation?: boolean;
  usage?: boolean;
  runtimeRequestResolution?: boolean;
  runtimeRequestHandoff?: boolean;
  goals?: boolean;
  threadLineage?: boolean;
  unsupported?: string[];
}

export interface RunnerPendingRequest {
  requestId: string;
  requestKind: string;
  method: string;
  turnId: string;
  itemId: string;
  status: string;
  prompt: string;
  details: Record<string, unknown>;
}

export interface RunnerGoal {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface RunnerLineageEntry {
  threadId: string;
  providerSessionId: string | null;
  parentThreadId: string | null;
  depth: number;
  nickname: string | null;
  role: string | null;
  status: string;
}

export interface RunnerSessionState {
  sessionId: string;
  runId: string;
  normalizedSessionId: string;
  manifest: string | null;
  providerAuthentication: string;
  credentialsExposed: boolean;
  capabilities: RunnerCapabilities;
  driverSession: {
    driverSessionId: string;
    providerSessionId?: string | null;
    displayId?: string | null;
  };
  activeTurnId: string | null;
  pendingRequests: RunnerPendingRequest[];
  goal: RunnerGoal | null;
  lineage: RunnerLineageEntry[];
  cursor: number;
  snapshot: SessionSnapshot;
}

export interface ManifestSummary {
  id: string;
  name: string;
  purpose: string;
  scenarios: string[];
  objective: string;
  prompt: string;
  expectedObservations: string[];
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "terminal";

export type GoalOperation = "get" | "set" | "pause" | "resume" | "clear";

export type RunnerEventList = readonly PrpEvent[];

export const GOAL_OPERATIONS: readonly GoalOperation[] = [
  "set",
  "get",
  "pause",
  "resume",
  "clear",
];

/** Human labels for the five fixed goal verbs (interaction map §5). */
export const GOAL_OPERATION_LABELS: Record<GoalOperation, string> = {
  set: "Set goal…",
  get: "View",
  pause: "Pause",
  resume: "Resume",
  clear: "Clear",
};
