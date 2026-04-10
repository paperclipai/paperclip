export interface TelemetryState {
  installId: string;
  salt: string;
  createdAt: string;
  firstSeenVersion: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  endpoint?: string;
  app?: string;
  schemaVersion?: string;
}

/** Per-event object inside the backend envelope */
export interface TelemetryEvent {
  name: string;
  occurredAt: string;
  dimensions: Record<string, string | number | boolean>;
}

/** Full payload sent to the backend ingest endpoint */
export interface TelemetryEventEnvelope {
  app: string;
  schemaVersion: string;
  installId: string;
  version: string;
  events: TelemetryEvent[];
}

export type TelemetryEventName =
  | "install.started"
  | "install.completed"
  | "company.imported"
  | "project.created"
  | "routine.created"
  | "routine.run"
  | "goal.created"
  | "agent.created"
  | "skill.imported"
  | "agent.first_heartbeat"
  | "agent.task_completed"
  | "error.handler_crash"
  | `plugin.${string}`;
