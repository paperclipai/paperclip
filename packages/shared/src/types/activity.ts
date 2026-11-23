export interface ActivityEvent {
  id: string;
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  /** Person-facing name of the actor, such as an agent's or member's name, or "Board". */
  actorName?: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  responsibleUserId?: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}
