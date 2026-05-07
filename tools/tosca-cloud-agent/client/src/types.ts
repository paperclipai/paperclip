// ─── Credentials ─────────────────────────────────────────────────────────────

export interface PATCredentials {
  readonly type: "pat";
  readonly token: string;
}

export interface SSOCredentials {
  readonly type: "sso";
  readonly tenantUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export type ToscaCredentials = PATCredentials | SSOCredentials;

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PageParams {
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceParams {
  name: string;
  description?: string;
}

export interface UpdateWorkspaceParams {
  name?: string;
  description?: string;
}

// ─── Project ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectParams {
  name: string;
  description?: string;
}

export interface UpdateProjectParams {
  name?: string;
  description?: string;
}

// ─── TestCase ─────────────────────────────────────────────────────────────────

export type TestCaseStatus = "active" | "inactive" | "deprecated";

export interface TestCase {
  id: string;
  projectId: string;
  workspaceId: string;
  name: string;
  description: string;
  status: TestCaseStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTestCaseParams {
  name: string;
  description?: string;
  tags?: string[];
}

export interface UpdateTestCaseParams {
  name?: string;
  description?: string;
  status?: TestCaseStatus;
  tags?: string[];
}

// ─── Execution ────────────────────────────────────────────────────────────────

export type ExecutionStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "cancelled";

export interface ExecutionResult {
  testCaseId: string;
  status: ExecutionStatus;
  durationMs: number;
  error: string | null;
}

export interface Execution {
  id: string;
  workspaceId: string;
  projectId: string;
  status: ExecutionStatus;
  agentId: string | null;
  testCaseIds: string[];
  results: ExecutionResult[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateExecutionParams {
  projectId: string;
  testCaseIds: string[];
  agentId?: string;
}

export interface CancelExecutionParams {
  reason?: string;
}

// ─── Agent / Runner ───────────────────────────────────────────────────────────

export type AgentStatus = "online" | "offline" | "busy";

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  version: string;
  capabilities: string[];
  workspaceIds: string[];
  registeredAt: string;
  lastSeenAt: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export interface ToscaApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ToscaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ToscaApiErrorBody,
  ) {
    super(`Tosca API ${status}: ${body.message}`);
    this.name = "ToscaApiError";
  }
}

export class ToscaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToscaAuthError";
  }
}
