import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRevisionModalView,
  parseRevisionModalSubmission,
  submitRevisionModal,
  REVISION_MODAL_BLOCK_ID,
  REVISION_MODAL_INPUT_ID,
} from "../approval-actions.js";
import { REVISION_MODAL_CALLBACK_ID } from "../constants.js";

const BASE = "http://pc.local";
const COMPANY = "company-1";
const APPROVAL = "approval-42";
const CHANNEL = "C_APPROVALS";
const TS = "1717200000.000100";

function makeCtx() {
  const store = new Map<string, unknown>();
  const call = vi.fn(async () => ({ applied: true, status: "needs_revision" }));
  const fetch = vi.fn(
    async (): Promise<{
      status: number;
      json: () => Promise<Record<string, unknown>>;
    }> => ({ status: 200, json: async () => ({ ok: true }) }),
  );
  const ctx = {
    rpc: { call },
    http: { fetch },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: { write: vi.fn(async () => undefined) },
    state: {
      get: vi.fn(async ({ stateKey }: { stateKey: string }) => store.get(stateKey) ?? null),
      set: vi.fn(async ({ stateKey }: { stateKey: string }, value: unknown) => {
        store.set(stateKey, value);
      }),
      delete: vi.fn(async ({ stateKey }: { stateKey: string }) => {
        store.delete(stateKey);
      }),
    },
  };
  return { ctx, fetch, call, store };
}

/** Build a Slack view_submission payload for our revision modal. */
function submissionPayload(opts: {
  callbackId?: string;
  metadata?: unknown;
  reason?: string | undefined;
}) {
  const block: Record<string, unknown> = {};
  if (opts.reason !== undefined) {
    block[REVISION_MODAL_BLOCK_ID] = {
      [REVISION_MODAL_INPUT_ID]: { value: opts.reason },
    };
  }
  return {
    type: "view_submission",
    user: { id: "U_OMAR" },
    view: {
      callback_id: opts.callbackId ?? REVISION_MODAL_CALLBACK_ID,
      private_metadata:
        opts.metadata === undefined
          ? JSON.stringify({ approvalId: APPROVAL, channel: CHANNEL, ts: TS })
          : typeof opts.metadata === "string"
            ? opts.metadata
            : JSON.stringify(opts.metadata),
      state: { values: block },
    },
  } as Record<string, unknown>;
}

describe("buildRevisionModalView", () => {
  it("produces a modal with our callback_id, a required reason input, and round-trippable private_metadata", () => {
    const view = buildRevisionModalView({
      approvalId: APPROVAL,
      channel: CHANNEL,
      ts: TS,
    });

    expect(view.type).toBe("modal");
    expect(view.callback_id).toBe(REVISION_MODAL_CALLBACK_ID);
    expect(view.submit).toBeDefined();

    // The approval id + card location survive the round-trip via private_metadata.
    expect(JSON.parse(String(view.private_metadata))).toEqual({
      approvalId: APPROVAL,
      channel: CHANNEL,
      ts: TS,
    });

    const blocks = view.blocks as Array<Record<string, unknown>>;
    const input = blocks.find((b) => b.block_id === REVISION_MODAL_BLOCK_ID);
    expect(input).toBeDefined();
    // Reason is mandatory — Slack blocks an empty submit client-side.
    expect(input?.optional).toBe(false);
    expect((input?.element as Record<string, unknown>).action_id).toBe(
      REVISION_MODAL_INPUT_ID,
    );
  });
});

describe("parseRevisionModalSubmission", () => {
  it("extracts metadata + trimmed reason from a valid submission", () => {
    const parsed = parseRevisionModalSubmission(
      submissionPayload({ reason: "  needs a budget breakdown  " }),
    );
    expect(parsed).toEqual({
      metadata: { approvalId: APPROVAL, channel: CHANNEL, ts: TS },
      reason: "needs a budget breakdown",
    });
  });

  it("returns null for a foreign callback_id (not our modal)", () => {
    expect(
      parseRevisionModalSubmission(
        submissionPayload({ callbackId: "some_other_modal", reason: "x" }),
      ),
    ).toBeNull();
  });

  it("returns null when the reason is empty/whitespace", () => {
    expect(
      parseRevisionModalSubmission(submissionPayload({ reason: "   " })),
    ).toBeNull();
  });

  it("returns null when the reason block is absent", () => {
    expect(
      parseRevisionModalSubmission(submissionPayload({ reason: undefined })),
    ).toBeNull();
  });

  it("returns null when private_metadata is malformed or missing fields", () => {
    expect(
      parseRevisionModalSubmission(
        submissionPayload({ metadata: "not-json", reason: "x" }),
      ),
    ).toBeNull();
    expect(
      parseRevisionModalSubmission(
        submissionPayload({ metadata: { approvalId: APPROVAL }, reason: "x" }),
      ),
    ).toBeNull();
  });
});

describe("submitRevisionModal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lands the reason on the approval via the revise host RPC", async () => {
    const { ctx, call } = makeCtx();
    const res = await submitRevisionModal(ctx as never, "xoxb-token", {
      companyId: COMPANY,
      slackUserId: "U_OMAR",
      metadata: { approvalId: APPROVAL, channel: CHANNEL, ts: TS },
      reason: "needs a budget breakdown",
      paperclipBaseUrl: BASE,
    });

    expect(res.ok).toBe(true);
    // The host approvals.resolve RPC was called with decision=revise + the
    // reason carried as decisionNote (resolvePaperclipApproval maps
    // reason → decisionNote; there is no top-level `reason` on the RPC).
    expect(call).toHaveBeenCalledTimes(1);
    const [method, payload] = call.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("approvals.resolve");
    expect(payload.approvalId).toBe(APPROVAL);
    expect(payload.decision).toBe("revise");
    expect(payload.decisionNote).toBe("needs a budget breakdown");
  });

  it("is a non-terminal no-op when the approval is already committed (does not flip it)", async () => {
    const { ctx, call } = makeCtx();
    // Seed the resolved lock so requestRevision short-circuits before the RPC.
    ctx.state.set(
      { stateKey: STATE_KEYS_resolved(APPROVAL) } as never,
      { decision: "approve", by: "U_PRIOR" } as never,
    );

    const res = await submitRevisionModal(ctx as never, "xoxb-token", {
      companyId: COMPANY,
      slackUserId: "U_OMAR",
      metadata: { approvalId: APPROVAL, channel: CHANNEL, ts: TS },
      reason: "too late",
      paperclipBaseUrl: BASE,
    });

    expect(res.ok).toBe(false);
    expect(res.alreadyResolved).toBe(true);
    // No host resolve RPC fired — the prior decision is untouched.
    expect(call).not.toHaveBeenCalled();
  });
});

// Mirror of STATE_KEYS.approvalResolved without importing the whole module map
// shape into the test's type space (constants is imported above for the id).
function STATE_KEYS_resolved(approvalId: string): string {
  return `approval-resolved-${approvalId}`;
}
