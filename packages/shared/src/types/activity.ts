export interface ActivityEvent {
  id: string;
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
  /** Populated for issue-type events from the DB join. */
  issueIdentifier?: string | null;
  issueTitle?: string | null;
}
