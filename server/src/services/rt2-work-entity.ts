// Lightweight Work Entity service with event emission scaffold for RT2
// This file implements the core operations for Work Entities and emits domain events

import type { Db } from '@paperclipai/db';
import { rt2V33WorkEntities, rt2V33DomainEvents } from '@paperclipai/db';
import { v4 as uuidv4 } from 'uuid';
import type { AppendRt2DomainEvent } from '@paperclipai/shared';
import { eq } from 'drizzle-orm';
import type { Rt2DomainEvent } from '@paperclipai/shared';
// Row type derived from drizzle schema (best-effort)
type Rt2V33WorkEntitiesRow = typeof rt2V33WorkEntities.$inferSelect;

export interface CreateWorkInput {
  companyId: string;
  taskIssueId?: string;
  deliverableWorkProductId?: string;
  actorType?: Rt2DomainEventActorType;
  actorId?: string;
}

export interface UpdateWorkStateInput {
  workEntityId: string;
  newState: 'draft' | 'active' | 'completed' | 'cancelled';
  actorType?: Rt2DomainEventActorType;
  actorId?: string;
}

export function rt2WorkEntityService(db: Db) {
  // createWork: inserts rt2V33WorkEntities with state='draft', emits rt2.work.created
  async function createWork(input: CreateWorkInput): Promise<Rt2V33WorkEntitiesRow> {
    const workEntityId = uuidv4();
    const now = new Date();
    const row: any = {
      id: workEntityId,
      companyId: input.companyId,
      taskIssueId: input.taskIssueId ?? null,
      deliverableWorkProductId: input.deliverableWorkProductId ?? null,
      state: 'draft',
      archivedAt: null,
      legacySourceId: null,
      createdAt: now,
      updatedAt: now,
    };
    // Persist using drizzle-like API
    if ((db as any).insert) {
      await (db as any).insert(rt2V33WorkEntities).values(row);
    }

    // Emit domain event (idempotency key pattern)
    const event = {
      id: uuidv4(),
      companyId: input.companyId,
      eventType: 'rt2.work.created',
      idempotencyKey: `rt2.work.created:${workEntityId}`,
      payload: { workEntityId, taskIssueId: input.taskIssueId, deliverableWorkProductId: input.deliverableWorkProductId },
      occurredAt: now,
    };
    if ((db as any).insert) {
      await (db as any).insert(rt2V33DomainEvents).values(event);
    }

    // Update projector/read-model
    if (typeof (global as any).processEvent === 'function') {
      await (global as any).processEvent('rt2.work_entity_projector', event.id, async (_evt: any) => {});
    }
    return row;
  }

  async function updateWorkState(input: UpdateWorkStateInput): Promise<Rt2V33WorkEntitiesRow> {
    // Fetch existing - placeholder using drizzle pattern
    const existing: any = await (db as any)
      .select()
      .from(rt2V33WorkEntities)
      .where(eq(rt2V33WorkEntities.id, input.workEntityId))
      .then((rows: any[]) => rows[0] ?? null);
    const currentState = existing?.state ?? 'draft';
    // Terminal states
    if (currentState === 'completed' || currentState === 'cancelled') {
      throw new Error('Cannot transition from terminal state');
    }
    // Validate allowed transitions (simple enforcement)
    const valid = (currentState === 'draft' && input.newState === 'active') ||
                  (currentState === 'active' && (input.newState === 'completed' || input.newState === 'cancelled'));
    if (!valid && input.newState !== currentState) {
      throw new Error('Invalid state transition');
    }
    const updated: any = { ...existing, state: input.newState, updatedAt: new Date() };
    if ((db as any).update) {
      await (db as any).update(rt2V33WorkEntities).set(updated).where(eq(rt2V33WorkEntities.id, input.workEntityId));
    }

    // Emit domain event: state_changed
    const event: AppendRt2DomainEvent = {
      companyId: existing?.companyId ?? input.companyId,
      eventType: 'rt2.work.state_changed',
      eventVersion: 1,
      entityType: 'work',
      entityId: input.workEntityId,
      payload: { workEntityId: input.workEntityId, previousState: currentState, newState: input.newState },
      idempotencyKey: `rt2.work.state_changed:${input.workEntityId}:${input.newState}`,
      occurredAt: new Date(),
    } as any;
    if ((db as any).insert) {
      await (db as any).insert(rt2V33DomainEvents).values(event);
    }
    if (typeof (global as any).processEvent === 'function') {
      await (global as any).processEvent('rt2.work_entity_projector', (event as any).id, async (_evt: any) => {});
    }
    return updated;
  }

  async function archiveWork(workEntityId: string, migrationBatchId: string): Promise<void> {
    // Archive by setting archivedAt
    if ((db as any).update) {
      await (db as any).update(rt2V33WorkEntities).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(rt2V33WorkEntities.id, workEntityId));
    }
    const event: AppendRt2DomainEvent = {
      companyId: '',
      eventType: 'rt2.work.archived',
      eventVersion: 1,
      entityType: 'work',
      entityId: workEntityId,
      payload: { workEntityId },
      idempotencyKey: `rt2.work.archived:${workEntityId}:${migrationBatchId}`,
      occurredAt: new Date(),
    } as any;
    if ((db as any).insert) {
      await (db as any).insert(rt2V33DomainEvents).values(event);
    }
    if (typeof (global as any).processEvent === 'function') {
      await (global as any).processEvent('rt2.work_entity_projector', (event as any).id, async (_evt: any) => {});
    }
  }

  async function getWorkById(workEntityId: string): Promise<any> {
    if (db?.select?.bind) {
      return await db.select('rt2_v33_work_entities').where({ id: workEntityId });
    }
    return null;
  }

  async function listWorksByCompany(companyId: string, state?: string): Promise<any[]> {
    if (!db?.select?.bind) return [];
    const q: any = { companyId };
    if (state) q.state = state;
    return await db.select('rt2_v33_work_entities').where(q);
  }

  async function getWorkProjectorReadModel(companyId: string): Promise<any> {
    // Simple aggregation placeholders
    const total = await (db?.count?.bind ? db.count('rt2_v33_work_entities').where({ companyId }) : 0);
    const draft = await (db?.count?.bind ? db.count('rt2_v33_work_entities').where({ companyId, state: 'draft' }) : 0);
    const active = await (db?.count?.bind ? db.count('rt2_v33_work_entities').where({ companyId, state: 'active' }) : 0);
    const completed = await (db?.count?.bind ? db.count('rt2_v33_work_entities').where({ companyId, state: 'completed' }) : 0);
    const cancelled = await (db?.count?.bind ? db.count('rt2_v33_work_entities').where({ companyId, state: 'cancelled' }) : 0);
    return { total, draft, active, completed, cancelled };
  }

  return {
    createWork,
    updateWorkState,
    archiveWork,
    getWorkById,
    listWorksByCompany,
    getWorkProjectorReadModel,
  };
}
