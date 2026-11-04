import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import type { AuthorizationActor, AuthorizationDecision } from "../services/authorization.js";
import { canActorReadHeartbeatRun } from "../services/heartbeat-run-privacy.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const issueId = "00000000-0000-4000-8000-000000000003";
const actor = { type: "board", userId: "user-1", source: "session" } as AuthorizationActor;
const run = { companyId, scopeKind: "issue" as const, issueId };

function disconnected(code = "CONNECTION_CLOSED") {
  return new Error("Failed query", {
    cause: Object.assign(new Error(`write ${code}`), { code }),
  });
}

function fixture(options: { issueFailures?: Error[]; decideFailures?: Error[]; missing?: boolean; allowed?: boolean } = {}) {
  let issueReads = 0;
  const select = vi.fn(() => ({
    from: () => ({
      where: () => {
        // A failed query object stays failed. Recovery must build another one.
        const attempt = issueReads++;
        const result = Promise.resolve().then(() => {
          const error = options.issueFailures?.[attempt];
          if (error) throw error;
          return options.missing ? [] : [{ id: issueId }];
        });
        return { then: result.then.bind(result) };
      },
    }),
  }));
  let decisions = 0;
  const decide = vi.fn(async () => {
    const error = options.decideFailures?.[decisions++];
    if (error) throw error;
    return { allowed: options.allowed ?? true } as AuthorizationDecision;
  });
  return { db: { select } as unknown as Db, access: { decide }, select, decide };
}

describe("heartbeat run read decision connection recovery", () => {
  it("rebuilds the issue existence read after a transient disconnect", async () => {
    const test = fixture({ issueFailures: [disconnected(), disconnected("CONNECT_TIMEOUT")] });

    await expect(canActorReadHeartbeatRun(test.db, test.access, actor, run)).resolves.toBe(true);
    expect(test.select).toHaveBeenCalledTimes(3);
    expect(test.decide).toHaveBeenCalledTimes(1);
  });

  it("retries only the issue:read decision when it disconnects", async () => {
    const test = fixture({ decideFailures: [disconnected()], allowed: false });

    await expect(canActorReadHeartbeatRun(test.db, test.access, actor, run)).resolves.toBe(false);
    expect(test.select).toHaveBeenCalledTimes(1);
    expect(test.decide).toHaveBeenCalledTimes(2);
    expect(test.decide).toHaveBeenLastCalledWith(expect.objectContaining({
      actor,
      action: "issue:read",
      resource: expect.objectContaining({ type: "issue", companyId, issueId }),
    }));
  });

  it("returns the final error after three disconnected attempts", async () => {
    const errors = [disconnected(), disconnected(), disconnected()];
    const test = fixture({ decideFailures: errors });

    await expect(canActorReadHeartbeatRun(test.db, test.access, actor, run)).rejects.toBe(errors[2]);
    expect(test.decide).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors", async () => {
    const error = new Error("permission denied for table issues");
    const test = fixture({ issueFailures: [error] });

    await expect(canActorReadHeartbeatRun(test.db, test.access, actor, run)).rejects.toBe(error);
    expect(test.select).toHaveBeenCalledTimes(1);
    expect(test.decide).not.toHaveBeenCalled();
  });

  it("keeps missing issues and company-scoped runs unchanged", async () => {
    const missing = fixture({ missing: true });
    await expect(canActorReadHeartbeatRun(missing.db, missing.access, actor, run)).resolves.toBe(false);
    expect(missing.decide).not.toHaveBeenCalled();

    const company = fixture();
    await expect(canActorReadHeartbeatRun(company.db, company.access, actor, { companyId, scopeKind: "company" }))
      .resolves.toBe(true);
    expect(company.select).not.toHaveBeenCalled();
  });
});
