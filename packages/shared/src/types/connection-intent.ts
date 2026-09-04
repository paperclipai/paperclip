import type { ConnectionIntentInteraction } from "./issue.js";
import type { ToolConnection } from "./tool-access.js";

export type ConnectionAvailabilityState =
  | "ready"
  | "needs_user_action"
  | "available"
  | "unavailable";

export interface ConnectionSearchResultItem {
  service: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  methods: Array<{
    key: string;
    label: string;
    auth: "oauth" | "api_key" | "none";
  }>;
  state: ConnectionAvailabilityState;
  connectionId: string | null;
}

export interface ConnectionsSearchResult {
  version: 1;
  query: string;
  results: ConnectionSearchResultItem[];
}

export interface ConnectionRequestResult {
  version: 1;
  service: string;
  state: "ready" | "needs_user_action";
  connectionId: string | null;
  interactionId: string | null;
  instruction: string;
}

export interface ConnectionIntentSetupOptions {
  version: 1;
  interaction: ConnectionIntentInteraction;
  service: ConnectionSearchResultItem;
  existingConnections: ToolConnection[];
  requestedAgentId: string;
}

export interface CompleteConnectionIntentInput {
  connectionId: string;
}

export interface DeclineConnectionIntentInput {
  reason?: string;
}
