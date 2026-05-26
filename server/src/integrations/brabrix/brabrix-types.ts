export interface BrabrixProjectContext {
  projectId: string;
  name: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BrabrixTask {
  taskId: string;
  title: string;
  description?: string | null;
  payload?: Record<string, unknown>;
}

export type BrabrixRunLogLevel = "debug" | "info" | "warn" | "error";

export interface BrabrixRunLogEntry {
  timestamp: string;
  level: BrabrixRunLogLevel;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface BrabrixSendRunLogsInput {
  taskId?: string | null;
  runId?: string | null;
  logs: BrabrixRunLogEntry[];
}

export type BrabrixTaskCompletionStatus = "completed" | "failed" | "canceled";

export interface BrabrixCompleteTaskInput {
  taskId: string;
  status: BrabrixTaskCompletionStatus;
  summary?: string | null;
  output?: Record<string, unknown> | null;
}
