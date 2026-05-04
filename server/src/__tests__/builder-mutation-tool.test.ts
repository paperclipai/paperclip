import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { defineMutationTool, isMutationTool } from "../services/builder/tools/mutation-tool.js";
import type { BuilderProposal } from "@paperclipai/shared";

/**
 * Unit tests for the mutation-tool helper used by Phase 1/2 builder tools.
 *
 * These exercise the proposal-creation path and the "is the applier
 * dispatchable" check without spinning up Postgres. The proposal lifecycle
 * end-to-end is exercised by the existing builder-routes integration test.
 */

const sessionId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";

function fakeProposalStore() {
  const created: Array<Parameters<NonNullable<unknown>>[0]> = [];
  return {
    state: created,
    store: {
      create: vi.fn(async (input: { kind: string; payload: Record<string, unknown> }) => {
        created.push(input as never);
        const proposal: BuilderProposal = {
          id: `prop-${created.length}`,
          sessionId,
          messageId,
          companyId,
          kind: input.kind,
          payload: input.payload,
          status: "pending",
          appliedActivityId: null,
          approvalId: null,
          decidedByUserId: null,
          decidedAt: null,
          failureReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return proposal;
      }),
    },
  };
}

describe("mutation-tool helper", () => {
  it("creates a proposal instead of mutating directly", async () => {
    const apply = vi.fn();
    const tool = defineMutationTool({
      name: "test_create",
      description: "test tool",
      parametersSchema: { type: "object", properties: { name: { type: "string" } } },
      capability: "test",
      buildPayload(params) {
        return { name: String(params.name).trim() };
      },
      summarize(payload) {
        return `Create ${String(payload.name)}`;
      },
      apply,
    });

    expect(isMutationTool(tool)).toBe(true);
    expect(tool.proposalKind).toBe("test_create");
    expect(tool.requiresApproval).toBe(true);

    const { store } = fakeProposalStore();
    const result = await tool.run(
      { name: "  hello  " },
      {
        companyId,
        sessionId,
        messageId,
        actor: { type: "user", id: "user-1" },
        db: {} as unknown as Db,
        proposalStore: store as unknown as Parameters<typeof tool.run>[1]["proposalStore"],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposalId).toBe("prop-1");
    expect(apply).not.toHaveBeenCalled();
    expect(store.create).toHaveBeenCalledOnce();
    const payload = store.create.mock.calls[0][0].payload;
    expect(payload.name).toBe("hello");
    expect(result.result).toMatchObject({
      status: "pending",
      summary: "Create hello",
      proposalId: "prop-1",
    });
  });

  it("returns a structured error when buildPayload throws", async () => {
    const tool = defineMutationTool({
      name: "test_strict",
      description: "test tool",
      parametersSchema: { type: "object" },
      capability: "test",
      buildPayload() {
        throw new Error("missing field x");
      },
      summarize() {
        return "noop";
      },
      apply: vi.fn(),
    });

    const { store } = fakeProposalStore();
    const result = await tool.run(
      {},
      {
        companyId,
        sessionId,
        messageId,
        actor: { type: "user", id: "user-1" },
        db: {} as unknown as Db,
        proposalStore: store as unknown as Parameters<typeof tool.run>[1]["proposalStore"],
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing field x");
    expect(store.create).not.toHaveBeenCalled();
  });

  it("makes proposalKind addressable for the proposal-apply route", () => {
    const tool = defineMutationTool({
      name: "test_route",
      description: "x",
      parametersSchema: { type: "object" },
      capability: "test",
      buildPayload: () => ({}),
      summarize: () => "x",
      apply: vi.fn(),
    });
    expect(isMutationTool(tool)).toBe(true);
    expect(tool.proposalKind).toBe(tool.name);
  });
});
