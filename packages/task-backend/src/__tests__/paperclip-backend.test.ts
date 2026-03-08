import { describe, it, expect, expectTypeOf } from 'vitest';
import type { TaskBackend, Issue, CreateIssueInput, UpdateIssueInput, IssueQuery, IssueList, Comment, IssueStatus, IssuePriority, DependencyInfo } from '../types.js';
import { PaperclipBackend } from '../paperclip-backend.js';

describe('PaperclipBackend', () => {
  describe('type compliance', () => {
    it('should implement TaskBackend interface', () => {
      const mockDb = {} as any;
      const backend = new PaperclipBackend(mockDb, { companyId: 'test-company-id' });
      
      expectTypeOf(backend).toMatchTypeOf<TaskBackend>();
    });

    it('should have type property set to paperclip', () => {
      const mockDb = {} as any;
      const backend = new PaperclipBackend(mockDb, { companyId: 'test-company-id' });
      
      expect(backend.type).toBe('paperclip');
    });
  });

  describe('constructor', () => {
    it('should accept db and options', () => {
      const mockDb = {} as any;
      const options = { companyId: 'test-company-id' };
      
      const backend = new PaperclipBackend(mockDb, options);
      
      expect(backend).toBeDefined();
      expect(backend.type).toBe('paperclip');
    });
  });

  describe('dependencies (stubbed)', () => {
    it('addDependency should throw not implemented error', async () => {
      const mockDb = {} as any;
      const backend = new PaperclipBackend(mockDb, { companyId: 'test-company-id' });
      
      await expect(backend.addDependency('issue-1', 'issue-2')).rejects.toThrow(
        'Dependencies not yet implemented for Paperclip backend'
      );
    });

    it('removeDependency should throw not implemented error', async () => {
      const mockDb = {} as any;
      const backend = new PaperclipBackend(mockDb, { companyId: 'test-company-id' });
      
      await expect(backend.removeDependency('issue-1', 'issue-2')).rejects.toThrow(
        'Dependencies not yet implemented for Paperclip backend'
      );
    });

    it('getDependencies should return empty result', async () => {
      const mockDb = {} as any;
      const backend = new PaperclipBackend(mockDb, { companyId: 'test-company-id' });
      
      const result = await backend.getDependencies('issue-1');
      
      expect(result).toEqual({
        blockedBy: [],
        blocking: [],
        allBlockersDone: true,
      });
    });

    it('canProceed should always return true', async () => {
      const mockDb = {} as any;
      const backend = new PaperclipBackend(mockDb, { companyId: 'test-company-id' });
      
      const result = await backend.canProceed('issue-1');
      
      expect(result).toEqual({
        canProceed: true,
        blockers: [],
      });
    });
  });
});

describe('Types', () => {
  it('IssueStatus should have correct values', () => {
    const statuses: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'done', 'cancelled'];
    expect(statuses).toHaveLength(5);
  });

  it('IssuePriority should have correct values', () => {
    const priorities: IssuePriority[] = ['low', 'medium', 'high', 'urgent'];
    expect(priorities).toHaveLength(4);
  });

  it('CreateIssueInput should allow required and optional fields', () => {
    const minimal: CreateIssueInput = { title: 'Test' };
    const full: CreateIssueInput = {
      title: 'Test',
      description: 'Description',
      status: 'todo',
      priority: 'high',
      assigneeAgentId: 'agent-1',
      projectId: 'project-1',
      parentId: 'parent-1',
      externalId: 'ext-1',
    };
    
    expect(minimal.title).toBe('Test');
    expect(full.title).toBe('Test');
  });

  it('UpdateIssueInput should allow all optional fields', () => {
    const update: UpdateIssueInput = {
      title: 'Updated',
      description: 'Updated desc',
      status: 'in_progress',
      priority: 'urgent',
      assigneeAgentId: null,
      projectId: null,
      parentId: null,
    };
    
    expect(update.title).toBe('Updated');
  });

  it('IssueQuery should support all filter options', () => {
    const query: IssueQuery = {
      status: ['backlog', 'todo'],
      priority: 'high',
      assigneeAgentId: ['agent-1', 'agent-2'],
      projectId: 'project-1',
      parentId: null,
      limit: 10,
      offset: 20,
    };
    
    expect(query.limit).toBe(10);
    expect(query.offset).toBe(20);
  });
});
