import type { PrpEvent } from "../../../../src/protocol/replay-contract";
import type { SessionSnapshot } from "../../../../src/reducer/session-reducer";

/**
 * The browser only ever sees the demo server's public state and the canonical
 * PRP event stream. There is no second event model and no client-side session
 * cache: every surface reads these shapes or the reducer snapshot they carry.
 */
export interface LiveCapabilities {
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

export interface LivePendingRequest {
  requestId: string;
  requestKind: string;
  method: string;
  turnId: string;
  itemId: string;
  status: string;
  prompt: string;
  details: Record<string, unknown>;
}

export interface LiveGoal {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface LiveLineageEntry {
  threadId: string;
  providerSessionId: string | null;
  parentThreadId: string | null;
  depth: number;
  nickname: string | null;
  role: string | null;
  status: string;
}

export interface LiveSessionState {
  sessionId: string;
  runId: string;
  normalizedSessionId: string;
  manifest: string | null;
  providerAuthentication: string;
  credentialsExposed: boolean;
  capabilities: LiveCapabilities;
  driverSession: {
    driverSessionId: string;
    providerSessionId?: string | null;
    displayId?: string | null;
  };
  activeTurnId: string | null;
  pendingRequests: LivePendingRequest[];
  goal: LiveGoal | null;
  lineage: LiveLineageEntry[];
  cursor: number;
  snapshot: SessionSnapshot;
}

export interface LiveManifestSummary {
  id: string;
  name: string;
  purpose: string;
  scenarios: string[];
  objective: string;
  prompt: string;
  expectedObservations: string[];
}

export type LiveConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "terminal";

export type GoalOperation = "get" | "set" | "pause" | "resume" | "clear";

export type LiveEventList = readonly PrpEvent[];

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
