import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

import {
  assertNativeRuntimeRequestResolverAuthorized,
  NativeRuntimeRequestResolutionAuthorizationError,
  readPendingNativeRuntimeRequest,
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
