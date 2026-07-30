import { describe, expect, it } from "vitest";
import {
  resolveDirectDoneCloseSuccessionGuard,
  resolveSuccessfulRunHandoffSuccessionGuard,
} from "../routes/issues.js";

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

function makeDbMock(input?: {
  parentRows?: Array<{ id: string; status: string }>;
  openSiblingRows?: Array<{ id: string }>;
  correctiveRunRows?: unknown[];
  sourceRunRows?: unknown[];
  currentRunRows?: unknown[];
}) {
  let heartbeatLookupCount = 0;
  let genericLookupCount = 0;
  const parentRows = input?.parentRows ?? [{ id: "22222222-2222-4222-8222-222222222222", status: "in_progress" }];
  const openSiblingRows = input?.openSiblingRows ?? [];
  const correctiveRunRows = input?.correctiveRunRows ?? [{
    id: "run-2",
    companyId: "company-1",
    agentId: "33333333-3333-4333-8333-333333333333",
    contextSnapshot: {
      wakeReason: "finish_successful_run_handoff",
      sourceRunId: "run-1",
    },
  }];
  const sourceRunRows = input?.sourceRunRows ?? [{
    id: "run-1",
    companyId: "company-1",
    resultJson: {
      summary: [
        "The candidate is still not ready for promotion.",
        "Next authoritative blocker: packages/adapter-utils/src/acpx-engine/execute.test.ts",
      ].join("\n"),
    },
  }];
  const currentRunRows = input?.currentRunRows ?? [{
    id: "run-2",
    companyId: "company-1",
    resultJson: {
      summary: [
        "Live-promotion readiness is still not ready.",
        "Next authoritative blocker: FRA-1561 successor.",
      ].join("\n"),
    },
  }];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) => {
            heartbeatLookupCount += 1;
            let rows: unknown[];
            if (correctiveRunRows.length > 0 && heartbeatLookupCount === 1) {
              rows = correctiveRunRows;
            } else if (sourceRunRows.length > 0 && heartbeatLookupCount === 2) {
              rows = sourceRunRows;
            } else if (currentRunRows.length > 0 && heartbeatLookupCount === 1 && correctiveRunRows.length === 0) {
              rows = currentRunRows;
            } else {
              genericLookupCount += 1;
              rows = genericLookupCount === 1 ? parentRows : openSiblingRows;
            }
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
      db: makeDbMock({ openSiblingRows: [{ id: "44444444-4444-4444-8444-444444444444" }] }),
      issue: makeIssue(),
      actor: makeActor(),
      requestedStatus: "done",
    });

    expect(guard).toBeNull();
  });

  it("downgrades a direct agent done-close when the close comment still signals not-ready work and no successor exists", async () => {
    const guard = await resolveDirectDoneCloseSuccessionGuard({
      db: makeDbMock({ correctiveRunRows: [], sourceRunRows: [], currentRunRows: [] }),
      issue: makeIssue(),
      actor: makeActor(),
      requestedStatus: "done",
      commentBody: [
        "Live-promotion readiness: Not established.",
        "Next authoritative blocker: successor child still needs to be linked.",
      ].join("\n"),
    });

    expect(guard?.sourceRunId).toBe("run-2");
    expect(guard?.note).toContain("Direct done-close preserved succession semantics");
  });

  it("allows a direct agent done-close when an open successor sibling already exists", async () => {
    const guard = await resolveDirectDoneCloseSuccessionGuard({
      db: makeDbMock({
        correctiveRunRows: [],
        sourceRunRows: [],
        currentRunRows: [],
        openSiblingRows: [{ id: "44444444-4444-4444-8444-444444444444" }],
      }),
      issue: makeIssue(),
      actor: makeActor(),
      requestedStatus: "done",
      commentBody: [
        "Live-promotion readiness: Not established.",
        "Next authoritative blocker: successor child still needs to be linked.",
      ].join("\n"),
    });

    expect(guard).toBeNull();
  });
});
