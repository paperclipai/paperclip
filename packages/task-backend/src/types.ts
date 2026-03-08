export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export type IssuePriority = 'critical' | 'high' | 'medium' | 'low';

export interface TaskBackend {
  readonly type: 'paperclip' | 'plane';

  createIssue(data: CreateIssueInput): Promise<Issue>;
  getIssue(id: string): Promise<Issue | null>;
  updateIssue(id: string, data: UpdateIssueInput): Promise<Issue>;
  deleteIssue(id: string): Promise<void>;
  listIssues(query: IssueQuery): Promise<IssueList>;

  checkout(issueId: string, agentId: string): Promise<Issue>;
  release(issueId: string): Promise<Issue>;

  addDependency(issueId: string, blockedById: string): Promise<void>;
  removeDependency(issueId: string, blockedById: string): Promise<void>;
  getDependencies(issueId: string): Promise<DependencyInfo>;
  canProceed(issueId: string): Promise<{ canProceed: boolean; blockers: Issue[] }>;

  addComment(issueId: string, body: string): Promise<Comment>;
  listComments(issueId: string): Promise<Comment[]>;

  transitionStatus(issueId: string, status: IssueStatus): Promise<Issue>;

  syncToExternal?(issue: Issue): Promise<void>;
  syncFromExternal?(externalId: string): Promise<Issue>;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeAgentId?: string;
  projectId?: string;
  parentId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeAgentId?: string | null;
  comment?: string;
}

export interface IssueQuery {
  status?: IssueStatus[];
  assigneeAgentId?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
}

export interface Issue {
  id: string;
  backendType: 'paperclip' | 'plane';
  externalId?: string;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId?: string;
  projectId?: string;
  parentId?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  dependencies?: DependencyInfo;
}

export interface DependencyInfo {
  blockedBy: Issue[];
  blocking: Issue[];
  allBlockersDone: boolean;
}

export interface Comment {
  id: string;
  issueId: string;
  body: string;
  authorId?: string;
  createdAt: Date;
}

export interface IssueList {
  issues: Issue[];
  total: number;
  hasMore: boolean;
}
