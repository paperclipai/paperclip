import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { resolveWorkflowByInvocationTarget } from "../services/workflows.js";

function createMockDb(results: Array<Array<Record<string, unknown>>>) {
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const chain: {
      from: (table: unknown) => typeof chain;
      where: (clause: unknown) => typeof chain;
      then: <TResult1 = Array<Record<string, unknown>>, TResult2 = never>(
        onfulfilled?: ((value: Array<Record<string, unknown>>) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise<TResult1 | TResult2>;
    } = {
      from: () => chain,
      where: () => chain,
      then: (onfulfilled, onrejected) => Promise.resolve(rows).then(onfulfilled, onrejected),
    };
    return chain;
  });

  return { select } as unknown as Db & { select: typeof select };
}

describe("resolveWorkflowByInvocationTarget", () => {
  it("prefers workflow id over workflow key and capability", async () => {
    const db = createMockDb([
      [
        {
          id: "workflow-1",
          companyId: "company-1",
          workflowKey: "ignored-key",
          capabilities: ["ignored-capability"],
        },
      ],
    ]);

    await expect(
      resolveWorkflowByInvocationTarget(db, "company-1", {
        workflowId: "workflow-1",
        workflowKey: "content_strategist",
        capability: "content-strategist",
      }),
    ).resolves.toMatchObject({
      id: "workflow-1",
      workflowKey: "ignored-key",
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("formats attempted selectors when workflow lookup fails", async () => {
    const db = createMockDb([[]]);

    await expect(
      resolveWorkflowByInvocationTarget(db, "company-1", {
        workflowId: "workflow-404",
        workflowKey: "content_strategist",
        capability: "content-strategist",
      }),
    ).rejects.toThrow(
      /workflowId=workflow-404, workflowKey=content_strategist, capability=content-strategist/i,
    );
  });

  it("falls back through key and capability selectors when higher-precedence selectors are absent", async () => {
    const db = createMockDb([
      [
        {
          id: "workflow-2",
          companyId: "company-1",
          workflowKey: "content_strategist",
          capabilities: ["content-strategist"],
        },
      ],
      [
        {
          id: "workflow-3",
          companyId: "company-1",
          workflowKey: null,
          capabilities: ["content-strategist"],
        },
      ],
    ]);

    await expect(
      resolveWorkflowByInvocationTarget(db, "company-1", {
        workflowKey: "content_strategist",
        capability: "content-strategist",
      }),
    ).resolves.toMatchObject({
      id: "workflow-2",
    });

    await expect(
      resolveWorkflowByInvocationTarget(db, "company-1", {
        capability: "content-strategist",
      }),
    ).resolves.toMatchObject({
      id: "workflow-3",
    });
  });
});
