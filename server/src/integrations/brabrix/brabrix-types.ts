export interface SkillContext {
  skillKey: string;
  name: string;
  version?: string | null;
  provider?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProjectContext {
  projectId: string;
  name: string;
  description?: string | null;
  skills?: SkillContext[];
  providers?: string[];
  defaultProvider?: string | null;
  metadata?: Record<string, unknown>;
}

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export interface AgentRun {
  runId: string;
  agentId: string;
  provider: string;
  status: AgentRunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BrabrixTask {
  taskId: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  priority?: "low" | "medium" | "high" | "critical" | null;
  agentTypeHint?: string | null;
  prd?: string | null;
  technicalSpec?: string | null;
  stack?: string[];
  projectRules?: string[];
  acceptanceCriteria?: string[];
  skillContext?: SkillContext[];
  suggestedRun?: AgentRun | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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
  agentRun?: AgentRun | null;
  context?: Record<string, unknown> | null;
  logs: BrabrixRunLogEntry[];
}

export type BrabrixTaskCompletionStatus = "completed" | "failed" | "canceled";

export interface BrabrixCompleteTaskInput {
  taskId: string;
  status: BrabrixTaskCompletionStatus;
  runId?: string | null;
  agentRun?: AgentRun | null;
  summary?: string | null;
  output?: Record<string, unknown> | null;
}

export type BrabrixAgentProfileKey = "backend" | "frontend" | "qa";

export interface BrabrixAgentProfile {
  key: BrabrixAgentProfileKey;
  role: string;
  objective: string;
  allowedTools: string[];
  preferredModel: string;
}

export interface AgentGoal {
  source: "brabrix";
  sourceTaskId: string;
  sourceProjectId: string | null;
  title: string;
  description: string | null;
  level: "task";
  status: "planned";
  agentProfile: BrabrixAgentProfileKey;
  metadata?: Record<string, unknown>;
}

export type BrabrixProjectContext = ProjectContext;
