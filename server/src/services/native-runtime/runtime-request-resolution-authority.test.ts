import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  assertNativeRuntimeRequestResolverAuthorized,
  NativeRuntimeRequestResolutionAuthorizationError,
  readPendingNativeRuntimeRequest,
  readPendingNativeRuntimeRequestEvents,
  type PendingNativeRuntimeRequest,
} from "./runtime-request-resolution-authority.js";

function dbReturning(row: Record<string, unknown> | null): Db {
  const limit = vi.fn(async () => row ? [row] : []);
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit,
  };
  return { select: vi.fn(() => query) } as unknown as Db;
}

const binding = {
  companyId: "company-1",
  runId: "00000000-0000-4000-8000-000000000901",
  requestId: "request-1",
};

function createdEvent(requestKind: string) {
  return {
    eventType: "runtime_request.created",
    payload: {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        eventType: "runtime_request.created",
        sourceKind: "runner",
        runId: binding.runId,
        turnId: "turn-1",
        payload: {
          request: {
            requestId: binding.requestId,
            requestKind,
            turnId: "turn-1",
            status: "pending",
          },
        },
      },
    },
  };
}

describe("native runtime request resolution authority", () => {
  it("returns only DB-filtered latest pending creations per request identity", async () => {
    const pending = {
      id: 1,
      companyId: binding.companyId,
      runId: binding.runId,
      agentId: "agent-1",
      seq: 10,
      eventType: "runtime_request.created",
      stream: "system",
      level: "info",
      color: null,
      message: null,
      payload: createdEvent("user_input").payload,
      createdAt: new Date("2026-04-10T09:30:00.000Z"),
    };
    const predicates: unknown[] = [];
    const subquery = { name: "latest_runtime_requests" };
    const inner = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      as: vi.fn(() => subquery),
    };
    const outer = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn((condition: unknown) => {
        predicates.push(condition);
        return outer;
      }),
      then: (resolve: (rows: typeof pending[]) => unknown) => Promise.resolve([pending]).then(resolve),
    };
    const db = {
      selectDistinctOn: vi.fn(() => inner),
      select: vi.fn(() => outer),
    } as unknown as Db;

    await expect(readPendingNativeRuntimeRequestEvents(db, binding)).resolves.toEqual([pending]);
    expect(db.selectDistinctOn).toHaveBeenCalledTimes(1);
    expect(inner.as).toHaveBeenCalledWith("latest_runtime_requests");
    const query = new PgDialect().sqlToQuery(predicates[0] as never);
    expect(query.params).toContain("runtime_request.created");
    expect(query.sql).toContain("request,status}' = 'pending'");
  });

  it("derives privileged approval policy from the durable canonical request", async () => {
    await expect(
      readPendingNativeRuntimeRequest(
        dbReturning(createdEvent("command_approval")),
        binding,
      ),
    ).resolves.toEqual({
      ...binding,
      requestKind: "command_approval",
      turnId: "turn-1",
      resolverPolicy: "instance_admin",
    });
  });

  it("treats a terminal latest event as no longer pending", async () => {
    await expect(
      readPendingNativeRuntimeRequest(dbReturning({
        eventType: "runtime_request.resolved",
        payload: { prpEvent: { payload: { requestId: binding.requestId } } },
      }), binding),
    ).resolves.toBeNull();
  });

  it("denies ordinary humans for approvals but permits administrators", () => {
    const pending: PendingNativeRuntimeRequest = {
      ...binding,
      requestKind: "file_approval",
      turnId: "turn-1",
      resolverPolicy: "instance_admin",
    };
    expect(() => assertNativeRuntimeRequestResolverAuthorized(pending, {
      type: "user",
      userId: "ordinary-member",
      isInstanceAdmin: false,
    })).toThrowError(NativeRuntimeRequestResolutionAuthorizationError);
    expect(() => assertNativeRuntimeRequestResolverAuthorized(pending, {
      type: "user",
      userId: "instance-admin",
      isInstanceAdmin: true,
    })).not.toThrow();
  });

  it("keeps structured questions on the existing authenticated-human policy", () => {
    const pending: PendingNativeRuntimeRequest = {
      ...binding,
      requestKind: "runtime",
      turnId: "turn-1",
      resolverPolicy: "human_only",
    };
    expect(() => assertNativeRuntimeRequestResolverAuthorized(pending, {
      type: "user",
      userId: "company-member",
      isInstanceAdmin: false,
    })).not.toThrow();
  });
});
