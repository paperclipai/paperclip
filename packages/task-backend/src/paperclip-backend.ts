import type { Db } from '@paperclipai/db';
import { issues, issueComments } from '@paperclipai/db';
import { eq, and, inArray, desc, isNull, sql } from 'drizzle-orm';
import type {
  TaskBackend,
  Issue,
  CreateIssueInput,
  UpdateIssueInput,
  IssueQuery,
  IssueList,
  DependencyInfo,
  Comment,
  IssueStatus,
  IssuePriority,
} from './types.js';

type IssueRow = typeof issues.$inferSelect;
type NewIssueRow = typeof issues.$inferInsert;

export interface PaperclipBackendOptions {
  companyId: string;
}

export class PaperclipBackend implements TaskBackend {
  readonly type = 'paperclip' as const;
  
  constructor(
    private db: Db,
    private options: PaperclipBackendOptions
  ) {}

  async createIssue(data: CreateIssueInput): Promise<Issue> {
    const now = new Date();
    const insertData: NewIssueRow = {
      companyId: this.options.companyId,
      title: data.title,
      description: data.description ?? null,
      status: data.status ?? 'backlog',
      priority: data.priority ?? 'medium',
      assigneeAgentId: data.assigneeAgentId ?? null,
      projectId: data.projectId ?? null,
      parentId: data.parentId ?? null,
      createdAt: now,
      updatedAt: now,
      startedAt: data.status === 'in_progress' ? now : null,
    };

    const [row] = await this.db.insert(issues).values(insertData).returning();
    if (!row) {
      throw new Error('Failed to create issue');
    }
    return this.mapRowToIssue(row);
  }

  async getIssue(id: string): Promise<Issue | null> {
    const [row] = await this.db
      .select()
      .from(issues)
      .where(and(eq(issues.id, id), eq(issues.companyId, this.options.companyId)))
      .limit(1);
    
    if (!row) return null;
    return this.mapRowToIssue(row);
  }

  async updateIssue(id: string, data: UpdateIssueInput): Promise<Issue> {
    const existing = await this.getIssue(id);
    if (!existing) {
      throw new Error(`Issue not found: ${id}`);
    }

    const updateData: Partial<NewIssueRow> = {
      updatedAt: new Date(),
    };

    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description ?? null;
    if (data.status !== undefined) {
      updateData.status = data.status;
      if (data.status === 'in_progress' && !existing.startedAt) {
        updateData.startedAt = new Date();
      }
      if (data.status === 'done') {
        updateData.completedAt = new Date();
      }
      if (data.status === 'cancelled') {
        updateData.cancelledAt = new Date();
      }
    }
    if (data.priority !== undefined) updateData.priority = data.priority;
    if (data.assigneeAgentId !== undefined) {
      updateData.assigneeAgentId = data.assigneeAgentId ?? null;
    }
    if (data.projectId !== undefined) {
      updateData.projectId = data.projectId ?? null;
    }
    if (data.parentId !== undefined) {
      updateData.parentId = data.parentId ?? null;
    }

    const [row] = await this.db
      .update(issues)
      .set(updateData)
      .where(and(eq(issues.id, id), eq(issues.companyId, this.options.companyId)))
      .returning();
    
    if (!row) {
      throw new Error(`Failed to update issue: ${id}`);
    }
    return this.mapRowToIssue(row);
  }

  async deleteIssue(id: string): Promise<void> {
    await this.db
      .delete(issues)
      .where(and(eq(issues.id, id), eq(issues.companyId, this.options.companyId)));
  }

  async listIssues(query: IssueQuery): Promise<IssueList> {
    const conditions = [eq(issues.companyId, this.options.companyId)];
    
    if (query.status !== undefined) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      if (statuses.length === 1) {
        conditions.push(eq(issues.status, statuses[0]!));
      } else if (statuses.length > 1) {
        conditions.push(inArray(issues.status, statuses));
      }
    }
    
    if (query.priority !== undefined) {
      const priorities = Array.isArray(query.priority) ? query.priority : [query.priority];
      if (priorities.length === 1) {
        conditions.push(eq(issues.priority, priorities[0]!));
      } else if (priorities.length > 1) {
        conditions.push(inArray(issues.priority, priorities));
      }
    }
    
    if (query.assigneeAgentId !== undefined) {
      const assignees = Array.isArray(query.assigneeAgentId) 
        ? query.assigneeAgentId 
        : [query.assigneeAgentId];
      if (assignees.length === 1) {
        conditions.push(eq(issues.assigneeAgentId, assignees[0]!));
      } else if (assignees.length > 1) {
        conditions.push(inArray(issues.assigneeAgentId, assignees));
      }
    }
    
    if (query.projectId !== undefined) {
      conditions.push(eq(issues.projectId, query.projectId));
    }
    
    if (query.parentId !== undefined) {
      if (query.parentId === null) {
        conditions.push(isNull(issues.parentId));
      } else {
        conditions.push(eq(issues.parentId, query.parentId));
      }
    }

    const whereClause = and(...conditions);
    
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const countResult = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(whereClause);
    
    const total = countResult[0]?.count ?? 0;

    const rows = await this.db
      .select()
      .from(issues)
      .where(whereClause)
      .orderBy(desc(issues.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      issues: rows.map(row => this.mapRowToIssue(row)),
      total,
      hasMore: offset + rows.length < total,
    };
  }

  async checkout(issueId: string, agentId: string): Promise<Issue> {
    const existing = await this.getIssue(issueId);
    if (!existing) {
      throw new Error(`Issue not found: ${issueId}`);
    }

    const updateData: Partial<NewIssueRow> = {
      assigneeAgentId: agentId,
      updatedAt: new Date(),
    };

    if (existing.status === 'backlog' || existing.status === 'todo') {
      updateData.status = 'in_progress';
      if (!existing.startedAt) {
        updateData.startedAt = new Date();
      }
    }

    const [row] = await this.db
      .update(issues)
      .set(updateData)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, this.options.companyId)))
      .returning();
    
    if (!row) {
      throw new Error(`Failed to checkout issue: ${issueId}`);
    }
    return this.mapRowToIssue(row);
  }

  async release(issueId: string): Promise<Issue> {
    const [row] = await this.db
      .update(issues)
      .set({
        assigneeAgentId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, this.options.companyId)))
      .returning();
    
    if (!row) {
      throw new Error(`Failed to release issue: ${issueId}`);
    }
    return this.mapRowToIssue(row);
  }

  async addDependency(_issueId: string, _blockedById: string): Promise<void> {
    throw new Error('Dependencies not yet implemented for Paperclip backend');
  }

  async removeDependency(_issueId: string, _blockedById: string): Promise<void> {
    throw new Error('Dependencies not yet implemented for Paperclip backend');
  }

  async getDependencies(_issueId: string): Promise<DependencyInfo> {
    return { blockedBy: [], blocking: [], allBlockersDone: true };
  }

  async canProceed(_issueId: string): Promise<{ canProceed: boolean; blockers: Issue[] }> {
    return { canProceed: true, blockers: [] };
  }

  async addComment(issueId: string, body: string, authorId?: string): Promise<Comment> {
    const now = new Date();
    const [row] = await this.db
      .insert(issueComments)
      .values({
        companyId: this.options.companyId,
        issueId,
        body,
        authorAgentId: authorId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    
    if (!row) {
      throw new Error('Failed to create comment');
    }
    
    return {
      id: row.id,
      issueId: row.issueId,
      body: row.body,
      authorId: row.authorAgentId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listComments(issueId: string): Promise<Comment[]> {
    const rows = await this.db
      .select()
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, issueId),
        eq(issueComments.companyId, this.options.companyId)
      ))
      .orderBy(desc(issueComments.createdAt));
    
    return rows.map(row => ({
      id: row.id,
      issueId: row.issueId,
      body: row.body,
      authorId: row.authorAgentId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async transitionStatus(issueId: string, status: IssueStatus): Promise<Issue> {
    const existing = await this.getIssue(issueId);
    if (!existing) {
      throw new Error(`Issue not found: ${issueId}`);
    }

    const validTransitions: Record<IssueStatus, IssueStatus[]> = {
      'backlog': ['todo', 'in_progress', 'cancelled'],
      'todo': ['in_progress', 'backlog', 'cancelled'],
      'in_progress': ['done', 'cancelled', 'todo'],
      'done': ['in_progress'],
      'cancelled': ['backlog', 'todo'],
    };

    const allowed = validTransitions[existing.status] ?? [];
    if (!allowed.includes(status)) {
      throw new Error(
        `Invalid status transition from ${existing.status} to ${status}`
      );
    }

    return this.updateIssue(issueId, { status });
  }

  private mapRowToIssue(row: IssueRow): Issue {
    return {
      id: row.id,
      backendType: (row.backendType as Issue['backendType']) ?? 'paperclip',
      externalId: row.externalId ?? undefined,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status as IssueStatus,
      priority: row.priority as IssuePriority,
      assigneeAgentId: row.assigneeAgentId ?? undefined,
      projectId: row.projectId ?? undefined,
      parentId: row.parentId ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      startedAt: row.startedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      cancelledAt: row.cancelledAt ?? undefined,
    };
  }
}
