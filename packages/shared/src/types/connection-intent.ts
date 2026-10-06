import type { ConnectionIntentInteraction } from "./issue.js";
import type { ToolConnection } from "./tool-access.js";
import type { AskUserQuestionsQuestion } from "./issue.js";
import type { RemoteMcpConnectorId } from "../remote-mcp-connectors.js";

export type ConnectionAvailabilityState =
  | "ready"
  | "needs_user_action"
  | "available"
  | "unavailable";

export interface ConnectionSearchResultItem {
  service: string;
  source?: "catalog" | "configured" | "aggregator";
  aggregator?: {
    provider: RemoteMcpConnectorId;
    targetService: string;
    targetName: string;
    evidenceUrl: string | null;
    verifiedAt: string;
    readiness: "requires_provider_setup" | "requires_app_verification";
  };
  reason?: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  methods: Array<{
    key: string;
    label: string;
    auth: "oauth" | "api_key" | "none";
    /** AgentMail channel setup and tool methods support connection_request cards. */
    purpose?: "tool" | "channel" | "ai";
    /** Company-scoped setup destination for methods with a separate setup flow. */
    setupPath?: string;
  }>;
  state: ConnectionAvailabilityState;
  connectionId: string | null;
}

export interface ConnectionsSearchResult {
  version: 1;
  query: string;
  results: ConnectionSearchResultItem[];
  /** Paperclip-authored next step; provider content must never supply this field. */
  instruction?: string;
  providerQuestion?: AskUserQuestionsQuestion;
  selectionInteractionId?: string;
}

export interface ConnectionRequestResult {
  version: 1;
  service: string;
  state: "ready" | "needs_user_action";
  connectionId: string | null;
  interactionId: string | null;
  instruction: string;
}

/** Safe metadata for selecting a connection; never includes credential or transport configuration. */
export type ConnectionIntentSetupConnection = Pick<ToolConnection, "id" | "applicationId" | "name" | "status" | "enabled">;

export interface ConnectionIntentSetupOptions {
  /** Resume this request's saved AgentMail account after a partial setup. */
  emailSetup?: { credentialConnectionId: string | null; readyConnectionId: string | null };
  canGrantAccess?: boolean;
  aiConnection?: import("../ai-connections.js").AiConnectionBinding;
  /** Legacy authentication stays unchanged until the normal validated agent update succeeds. */
  aiConnectionRequiresAdoption?: boolean;
  /** Selected account, including an unavailable default. Reconnect must preserve its identity. */
  aiRepair?: {
    connection: import("../ai-connections.js").AiManagedConnectionSummary;
    canReconnect: boolean;
  };
  version: 1;
  interaction: ConnectionIntentInteraction;
  service: ConnectionSearchResultItem;
  existingConnections: ConnectionIntentSetupConnection[];
  requestedAgentId: string;
}

export interface CompleteConnectionIntentInput {
  connectionId: string;
}

export interface DeclineConnectionIntentInput {
  reason?: string;
}
