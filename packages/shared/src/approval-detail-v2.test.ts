import { describe, expect, it } from "vitest";
import {
  APPROVAL_DETAIL_CONTRACT_VERSION,
  hydrateApprovalDetailV2,
  type HydratableApproval,
} from "./approval-detail-v2.js";
import { approvalDetailV2Schema } from "./validators/approval.js";
import type { ApprovalType } from "./constants.js";

const BASE_TIME = new Date("2026-09-15T00:00:00.000Z");

function makeApproval(
  overrides: Partial<HydratableApproval> & { payload: Record<string, unknown>; type?: ApprovalType },
): HydratableApproval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: overrides.type ?? "request_board_approval",
    status: "pending",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

describe("hydrateApprovalDetailV2", () => {
  it("emits version 2 and validates against the contract schema", () => {
    const detail = hydrateApprovalDetailV2(
      makeApproval({ payload: { title: "Something to decide" } }),
    );
    expect(detail.version).toBe(APPROVAL_DETAIL_CONTRACT_VERSION);
    expect(detail.version).toBe(2);
    expect(approvalDetailV2Schema.safeParse(detail).success).toBe(true);
  });

  it("omits the raw payload by default and includes it only on opt-in", () => {
    const payload = { title: "Refund it", refundAmount: 42, orderId: "1234" };
    const withoutPayload = hydrateApprovalDetailV2(makeApproval({ payload }));
    expect(withoutPayload.payload).toBeUndefined();
    expect("payload" in withoutPayload).toBe(false);

    const withPayload = hydrateApprovalDetailV2(makeApproval({ payload }), {
      includePayload: true,
    });
    expect(withPayload.payload).toEqual(payload);
  });

  describe("refund-shaped payloads", () => {
    it("produces a non-empty refund side effect for a real refund payload", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          payload: {
            action: "refund",
            orderId: "OXFA-ORDER-8891",
            refundAmount: 129.5,
            currency: "USD",
            reason: "Damaged in transit",
            lineItems: ["Padron 1926", "Ashton VSG"],
          },
        }),
      );

      expect(detail.refund).toEqual({
        orderId: "OXFA-ORDER-8891",
        amount: 129.5,
        currency: "USD",
        reason: "Damaged in transit",
        lineItems: ["Padron 1926", "Ashton VSG"],
      });
      expect(detail.sideEffects.length).toBeGreaterThan(0);
      const refundEffect = detail.sideEffects.find((e) => e.kind === "refund");
      expect(refundEffect).toBeDefined();
      expect(refundEffect?.amount).toBe(129.5);
      expect(refundEffect?.currency).toBe("USD");
      expect(refundEffect?.target).toBe("OXFA-ORDER-8891");
    });

    it("reads refund fields from a nested refund container", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          payload: {
            refund: { order_id: "9002", amount: "$75.00", currency: "USD" },
          },
        }),
      );
      expect(detail.refund?.orderId).toBe("9002");
      expect(detail.refund?.amount).toBe(75);
      expect(detail.sideEffects.some((e) => e.kind === "refund")).toBe(true);
    });

    it("does not misclassify a generic board approval as a refund", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          payload: { title: "Approve new vendor", summary: "Onboard Warped" },
        }),
      );
      expect(detail.refund).toBeNull();
      expect(detail.sideEffects).toEqual([]);
    });
  });

  describe("reply-shaped payloads", () => {
    it("preserves recipient, subject, original and proposed message", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          payload: {
            action: "reply",
            recipient: "customer@example.com",
            subject: "Re: Where is my order?",
            originalMessage: "Hi, I ordered last week and it has not shipped.",
            proposedMessage: "Apologies for the delay — your order ships tomorrow.",
          },
        }),
      );

      expect(detail.reply).toEqual({
        recipient: "customer@example.com",
        subject: "Re: Where is my order?",
        originalMessage: "Hi, I ordered last week and it has not shipped.",
        proposedMessage: "Apologies for the delay — your order ships tomorrow.",
      });
      const replyEffect = detail.sideEffects.find((e) => e.kind === "email_reply");
      expect(replyEffect).toBeDefined();
      expect(replyEffect?.target).toBe("customer@example.com");
    });

    it("reads reply fields from a nested email container", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          payload: {
            reply: {
              to: "buyer@example.com",
              subject: "Your refund",
              body: "It has been processed.",
            },
          },
        }),
      );
      expect(detail.reply?.recipient).toBe("buyer@example.com");
      expect(detail.reply?.subject).toBe("Your refund");
      expect(detail.reply?.proposedMessage).toBe("It has been processed.");
    });

    it("keeps a reply nested under email with no subject and no top-level signal", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          payload: {
            email: {
              to: "shopper@example.com",
              body: "Thanks for reaching out — here is the update.",
            },
          },
        }),
      );
      expect(detail.reply).not.toBeNull();
      expect(detail.reply?.recipient).toBe("shopper@example.com");
      expect(detail.reply?.subject).toBeNull();
      expect(detail.reply?.proposedMessage).toBe(
        "Thanks for reaching out — here is the update.",
      );
      const replyEffect = detail.sideEffects.find((e) => e.kind === "email_reply");
      expect(replyEffect).toBeDefined();
      expect(replyEffect?.target).toBe("shopper@example.com");
    });

    it("does not treat a bare scalar email field as a reply", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          payload: { summary: "Generic board approval", email: "requester@example.com" },
        }),
      );
      expect(detail.reply).toBeNull();
      expect(detail.sideEffects.find((e) => e.kind === "email_reply")).toBeUndefined();
    });

    it("does not treat a generic nested draft with no email evidence as a reply", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          payload: {
            summary: "Approve the migration plan",
            draft: { title: "Migration plan", body: "Step 1: back up. Step 2: cut over." },
          },
        }),
      );
      expect(detail.reply).toBeNull();
      expect(detail.sideEffects.find((e) => e.kind === "email_reply")).toBeUndefined();
    });
  });

  describe("malformed persisted enums", () => {
    it("falls back an unknown status to the non-actionable 'cancelled', not 'pending'", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({ status: "legacy_unknown_state", payload: { title: "Legacy row" } }),
      );
      expect(detail.status).toBe("cancelled");
      expect(approvalDetailV2Schema.safeParse(detail).success).toBe(true);
    });

    it("falls back an unknown type to 'request_board_approval'", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({
          type: "legacy_unknown_type" as ApprovalType,
          payload: { title: "Legacy row" },
        }),
      );
      expect(detail.type).toBe("request_board_approval");
      expect(approvalDetailV2Schema.safeParse(detail).success).toBe(true);
    });
  });

  describe("hire_agent synthetic effects", () => {
    it("emits a hire_agent side effect", () => {
      const detail = hydrateApprovalDetailV2(
        makeApproval({ type: "hire_agent", payload: { agentName: "SEO Analyst" } }),
      );
      const hireEffect = detail.sideEffects.find((e) => e.kind === "hire_agent");
      expect(hireEffect).toBeDefined();
      expect(hireEffect?.target).toBe("SEO Analyst");
      expect(detail.refund).toBeNull();
      expect(detail.reply).toBeNull();
    });
  });

  it("prefers an explicit summary, else derives one", () => {
    const explicit = hydrateApprovalDetailV2(
      makeApproval({ payload: { summary: "Curated summary here" } }),
    );
    expect(explicit.summary).toBe("Curated summary here");

    const derivedRefund = hydrateApprovalDetailV2(
      makeApproval({ payload: { refundAmount: 10, orderId: "77" } }),
    );
    expect(derivedRefund.summary).toContain("Refund");
    expect(derivedRefund.summary).toContain("77");
  });
});
