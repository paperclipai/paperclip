export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'cancelled';

export type IssuePriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Issue {
  id: string;
  backendType: 'paperclip' | 'linear' | 'github';
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
  cancelledAt?: Date;
}

export interface CreateIssueInput {
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeAgentId?: string;
  projectId?: string;
  parentId?: string;
  externalId?: string;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  parentId?: string | null;
}

export interface IssueQuery {
  status?: IssueStatus | IssueStatus[];
  priority?: IssuePriority | IssuePriority[];
  assigneeAgentId?: string | string[];
  projectId?: string;
  parentId?: string | null;
  limit?: number;
  offset?: number;
}

export interface IssueList {
  issues: Issue[];
  total: number;
  hasMore: boolean;
}

export interface DependencyInfo {
  blockedBy: string[];
  blocking: string[];
  allBlockersDone: boolean;
}

export interface Comment {
  id: string;
  issueId: string;
  body: string;
  authorId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskBackend {
  readonly type: 'paperclip' | 'linear' | 'github';
  
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
  
  addComment(issueId: string, body: string, authorId?: string): Promise<Comment>;
  listComments(issueId: string): Promise<Comment[]>;
  
  transitionStatus(issueId: string, status: IssueStatus): Promise<Issue>;
}
