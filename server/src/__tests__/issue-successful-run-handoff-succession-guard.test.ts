import { describe, expect, it } from "vitest";
import { resolveSuccessfulRunHandoffSuccessionGuard } from "../routes/issues.js";

function makeIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-580",
    parentId: "22222222-2222-4222-8222-222222222222",
    assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    assigneeUserId: null,
  } as any;
}

function makeActor() {
  return {
    actorType: "agent",
    actorId: "33333333-3333-4333-8333-333333333333",
    agentId: "33333333-3333-4333-8333-333333333333",
    companyId: "company-1",
    runId: "run-2",
  } as any;
}

function makeDbMock(openSiblingRows: Array<{ id: string }> = []) {
  let heartbeatLookupCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) => {
            heartbeatLookupCount += 1;
            const rows = heartbeatLookupCount === 1
              ? [{
                  id: "run-2",
                  companyId: "company-1",
                  agentId: "33333333-3333-4333-8333-333333333333",
                  contextSnapshot: {
                    wakeReason: "finish_successful_run_handoff",
                    sourceRunId: "run-1",
                  },
                }]
              : heartbeatLookupCount === 2
                ? [{
                    id: "run-1",
                    companyId: "company-1",
                    resultJson: {
                      summary: [
                        "The candidate is still not ready for promotion.",
                        "Next authoritative blocker: packages/adapter-utils/src/acpx-engine/execute.test.ts",
                      ].join("\n"),
                    },
                  }]
                : openSiblingRows;
            return Promise.resolve(rows).then(onFulfilled, onRejected);
          },
        }),
      }),
    }),
  } as any;
}

describe("resolveSuccessfulRunHandoffSuccessionGuard", () => {
  it("flags not-ready closeouts with a named next blocker when no successor sibling is open", async () => {
    const guard = await resolveSuccessfulRunHandoffSuccessionGuard({
      db: makeDbMock(),
      issue: makeIssue(),
      actor: makeActor(),
      requestedStatus: "done",
    });

    expect(guard).toMatchObject({
      sourceRunId: "run-1",
    });
    expect(guard?.note).toContain("preserved succession semantics");
    expect(guard?.note).toContain("Next authoritative blocker");
  });

  it("allows done when an open successor sibling already exists", async () => {
    const guard = await resolveSuccessfulRunHandoffSuccessionGuard({
      db: makeDbMock([{ id: "44444444-4444-4444-8444-444444444444" }]),
      issue: makeIssue(),
      actor: makeActor(),
      requestedStatus: "done",
    });

    expect(guard).toBeNull();
  });
});
