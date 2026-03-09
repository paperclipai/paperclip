export interface NotificationChannel {
  id: string;
  companyId: string;
  channelType: string;
  name: string;
  config: Record<string, unknown>;
  eventFilter: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationEvent {
  id: string;
  type: string;
  companyId: string;
  occurredAt: string;
  actor: { type: "agent" | "user" | "system"; id: string };
  entity: { type: string; id: string };
  payload: Record<string, unknown>;
}
