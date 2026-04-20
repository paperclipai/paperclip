export const PLUGIN_ID = "plugin-linear-sync";
export const PLUGIN_VERSION = "0.1.0";

export const JOB_KEYS = {
  /** Polls Linear for new/updated issues and syncs them into Paperclip */
  inboundSync: "linear-inbound-sync",
  /** Pushes Paperclip issue status changes back to Linear */
  outboundSync: "linear-outbound-sync",
} as const;

export const WEBHOOK_KEYS = {
  /** Receives Linear webhook events (IssueCreated, IssueUpdated, etc.) */
  linearEvents: "linear-events",
} as const;

export const TOOL_NAMES = {
  /** Lets the CEO agent query Linear issues directly */
  queryLinear: "linear-query-issues",
  /** Lets agents update Linear issue status */
  updateLinear: "linear-update-issue",
} as const;

export const STATE_KEYS = {
  /** ISO timestamp of last successful inbound sync */
  lastSyncCursor: "linear-last-sync-cursor",
  /** ISO timestamp of last outbound push */
  lastOutboundCursor: "linear-last-outbound-cursor",
} as const;

export const ENTITY_TYPE = "linear-issue";

/** Linear GraphQL endpoint */
export const LINEAR_API = "https://api.linear.app/graphql";

/** Linear team ID for "Dan's Projects" */
export const LINEAR_TEAM_ID = "f741ad5a-88f7-4fa5-8adc-ff95d065fd3a";

/** Map Linear states to Paperclip statuses */
export const LINEAR_TO_PAPERCLIP_STATUS: Record<string, string> = {
  "Backlog": "backlog",
  "Todo": "backlog",
  "In Progress": "in_progress",
  "In Review": "in_progress",
  "Done": "done",
  "Canceled": "cancelled",
  "Duplicate": "cancelled",
};

/** Map Paperclip statuses back to Linear state IDs */
export const PAPERCLIP_TO_LINEAR_STATE: Record<string, string> = {
  "backlog": "a9690d32-4ce7-4d6b-b6b1-898db286d829",      // Backlog
  "in_progress": "1a17e7c5-c390-4b42-a5d5-7b13ce6276f3",  // In Progress
  "done": "02807f9c-83a5-4b67-9d72-167dac669fc6",          // Done
  "cancelled": "f94d02c9-5f4a-4eed-b9e0-79dced38a5d3",     // Canceled
};

/** Linear label IDs for domain routing */
export const LINEAR_LABELS: Record<string, string> = {
  "Accounting": "9d51ca07-7500-4350-9802-93298683ebc6",
  "Personal": "49262ecf-cbd5-4579-8f3a-67dbbd4dc4ef",
  "AMMA": "e87558f2-18f0-46ca-914b-158e7fbf771e",
  "Dev Tools": "f2e94b6a-a2c4-4b8b-ad3b-1db7af81e037",
  "Infrastructure": "36b84592-1982-4c4b-8325-7d59296018bb",
  "File-Reorg": "b57eeb75-9d12-43c2-a2b2-c87e81806c68",
  "Improvement": "edaf1d96-fc1f-4a6d-8f39-7a173a8b1b01",
};
