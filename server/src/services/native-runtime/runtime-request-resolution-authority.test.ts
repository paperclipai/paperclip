import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

const { readRunEventLane, runEventLane } = vi.hoisted(() => ({
  readRunEventLane: vi.fn(),
  runEventLane: vi.fn((_kind: string, key: string) => `request:${key}`),
}));
vi.mock("../run-event-history.js", () => ({ readRunEventLane, runEventLane }));

import {
  assertNativeRuntimeRequestResolverAuthorized,
  NativeRuntimeRequestResolutionAuthorizationError,
  readPendingNativeRuntimeRequest,
  type PendingNativeRuntimeRequest,
} from "./runtime-request-resolution-authority.js";

function dbReturning(_row: Record<string, unknown> | null): Db { return {} as Db; }

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
  it("reads only the request lane and enforces company binding", async () => {
    readRunEventLane.mockResolvedValueOnce([{ ...createdEvent("command_approval"), companyId: binding.companyId }]);
    await expect(readPendingNativeRuntimeRequest(dbReturning(null), binding)).resolves.toMatchObject({ requestKind: "command_approval" });
    expect(readRunEventLane).toHaveBeenLastCalledWith(expect.anything(), binding.runId, expect.stringMatching(/^request:/), 1);

    readRunEventLane.mockResolvedValueOnce([{ ...createdEvent("command_approval"), companyId: "other-company" }]);
    await expect(readPendingNativeRuntimeRequest(dbReturning(null), binding)).resolves.toBeNull();
  });

  it("derives privileged approval policy from the durable canonical request", async () => {
    readRunEventLane.mockResolvedValueOnce([{ ...createdEvent("command_approval"), companyId: binding.companyId }]);
    await expect(
      readPendingNativeRuntimeRequest(
        dbReturning(null),
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
    readRunEventLane.mockResolvedValueOnce([{
      companyId: binding.companyId,
      eventType: "runtime_request.resolved",
      payload: { prpEvent: { payload: { requestId: binding.requestId } } },
    }]);
    await expect(
      readPendingNativeRuntimeRequest(dbReturning(null), binding),
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
