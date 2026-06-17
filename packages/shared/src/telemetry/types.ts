export interface TelemetryState {
  installId: string;
  salt: string;
  createdAt: string;
  firstSeenVersion: string;
  seenEventNames?: string[];
}

export interface TelemetryConfig {
  enabled: boolean;
  endpoint?: string;
  app?: string;
  schemaVersion?: string;
}

export type TelemetryDimensions = Record<string, string | number | boolean>;

/** Per-event object inside the backend envelope */
export interface TelemetryEvent {
  name: string;
  occurredAt: string;
  dimensions: TelemetryDimensions;
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
  | "skill.invoked"
  | "task.created"
  | "task.status_changed"
  | "task.completed"
  | "task.blocked"
  | "task.reopened"
  | "interaction.created"
  | "interaction.resolved"
  | "product.first_task_completed"
  | "agent.first_heartbeat"
  | "agent.task_completed"
  | "error.handler_crash"
  | `plugin.${string}`
  | `ui.${string}`;
