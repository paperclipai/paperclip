import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { resolveTaskWatchdogMutationScope } from "../services/task-watchdog-scope.ts";

// TWX-1253: resolveTaskWatchdogMutationScope runs on the PATCH/POST /issues mutation
// path and queries heartbeat_runs.id = runId. A synthetic / non-uuid run id (e.g.
// "ceo-heartbeat") must short-circuit to { kind: "none" } instead of reaching Postgres,
// which would throw "invalid input syntax for type uuid" and 500 the issue write.
const throwingDb = {
  select() {
    throw new Error("db must not be queried for a non-uuid run id");
  },
} as unknown as Db;

describe("resolveTaskWatchdogMutationScope run id guard (TWX-1253)", () => {
  it("returns { kind: 'none' } for a non-uuid run id without touching the db", async () => {
    const scope = await resolveTaskWatchdogMutationScope(throwingDb, {
      type: "agent",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "ceo-heartbeat",
    });
    expect(scope).toEqual({ kind: "none" });
  });

  it("returns { kind: 'none' } for a timestamped synthetic run id", async () => {
    const scope = await resolveTaskWatchdogMutationScope(throwingDb, {
      type: "agent",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "ceo-heartbeat-20260707T080905Z",
    });
    expect(scope).toEqual({ kind: "none" });
  });

  it("still queries the db for a real uuid run id", async () => {
    let queried = false;
    const stubDb = {
      select() {
        queried = true;
        return {
          from() {
            return {
              where() {
                return { then: (cb: (rows: unknown[]) => unknown) => cb([]) };
              },
            };
          },
        };
      },
    } as unknown as Db;
    const scope = await resolveTaskWatchdogMutationScope(stubDb, {
      type: "agent",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
    });
    expect(queried).toBe(true);
    expect(scope).toEqual({ kind: "none" });
  });
});
