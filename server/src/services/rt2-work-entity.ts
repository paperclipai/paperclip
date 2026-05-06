// Lightweight Work Entity service with event emission scaffold for RT2
// This file implements the core operations for Work Entities and emits domain events

import type { Db } from '@paperclipai/db';
import { rt2V33WorkEntities, rt2V33DomainEvents } from '@paperclipai/db';
// uuid 사용 안 함 - 제거됨
import type { AppendRt2DomainEvent } from '@paperclipai/shared';
import { eq } from 'drizzle-orm';
import type { Rt2DomainEvent, Rt2DomainEventActorType } from '@paperclipai/shared';
import { randomUUID } from 'node:crypto';
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
    const workEntityId = randomUUID();
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
      id: randomUUID(),
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
      companyId: existing?.companyId ?? 'unknown',
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

  async function getWorkById(workEntityId: string): Promise<Rt2V33WorkEntitiesRow | null> {
    const results = await db.select().from(rt2V33WorkEntities).where(eq(rt2V33WorkEntities.id, workEntityId)).limit(1);
    return results[0] ?? null;
  }

  async function listWorksByCompany(companyId: string, state?: string): Promise<Rt2V33WorkEntitiesRow[]> {
    const baseWhere = [eq(rt2V33WorkEntities.companyId, companyId)];
    if (state) {
      return await db.select().from(rt2V33WorkEntities).where(eq(rt2V33WorkEntities.state, state as any)).limit(100);
    }
    return await db.select().from(rt2V33WorkEntities).where(baseWhere[0]).limit(100);
  }

  async function getWorkProjectorReadModel(companyId: string): Promise<{ total: number; draft: number; active: number; completed: number; cancelled: number }> {
    const all = await db.select().from(rt2V33WorkEntities).where(eq(rt2V33WorkEntities.companyId, companyId));
    return {
      total: all.length,
      draft: all.filter(w => w.state === 'draft').length,
      active: all.filter(w => w.state === 'active').length,
      completed: all.filter(w => w.state === 'completed').length,
      cancelled: all.filter(w => w.state === 'cancelled').length,
    };
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
