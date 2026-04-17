import { describe, expect, it } from "vitest";
import { createFinanceEventSchema } from "./finance.js";

const validEvent = {
  agentId: "00000000-0000-0000-0000-000000000001",
  eventKind: "inference_charge" as const,
  biller: "anthropic",
  amountCents: 100,
  occurredAt: "2026-01-01T00:00:00.000Z",
};

describe("createFinanceEventSchema", () => {
  it("accepts a minimal valid finance event", () => {
    expect(createFinanceEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("defaults direction to debit", () => {
    const result = createFinanceEventSchema.safeParse(validEvent);
    expect(result.success && result.data.direction).toBe("debit");
  });

  it("defaults currency to USD", () => {
    const result = createFinanceEventSchema.safeParse(validEvent);
    expect(result.success && result.data.currency).toBe("USD");
  });

  it("normalizes currency to uppercase", () => {
    const result = createFinanceEventSchema.safeParse({ ...validEvent, currency: "usd" });
    expect(result.success && result.data.currency).toBe("USD");
  });

  it("defaults estimated to false", () => {
    const result = createFinanceEventSchema.safeParse(validEvent);
    expect(result.success && result.data.estimated).toBe(false);
  });

  it("accepts valid eventKind values", () => {
    const kinds = [
      "inference_charge", "platform_fee", "credit_purchase", "credit_refund",
      "manual_adjustment",
    ];
    for (const eventKind of kinds) {
      expect(createFinanceEventSchema.safeParse({ ...validEvent, eventKind }).success).toBe(true);
    }
  });

  it("rejects an invalid eventKind", () => {
    expect(createFinanceEventSchema.safeParse({ ...validEvent, eventKind: "unknown" }).success).toBe(false);
  });

  it("accepts direction credit", () => {
    expect(createFinanceEventSchema.safeParse({ ...validEvent, direction: "credit" }).success).toBe(true);
  });

  it("rejects an invalid direction", () => {
    expect(createFinanceEventSchema.safeParse({ ...validEvent, direction: "transfer" }).success).toBe(false);
  });

  it("rejects a negative amountCents", () => {
    expect(createFinanceEventSchema.safeParse({ ...validEvent, amountCents: -1 }).success).toBe(false);
  });

  it("rejects a non-integer amountCents", () => {
    expect(createFinanceEventSchema.safeParse({ ...validEvent, amountCents: 1.5 }).success).toBe(false);
  });

  it("accepts zero amountCents", () => {
    expect(createFinanceEventSchema.safeParse({ ...validEvent, amountCents: 0 }).success).toBe(true);
  });

  it("rejects an empty biller", () => {
    expect(createFinanceEventSchema.safeParse({ ...validEvent, biller: "" }).success).toBe(false);
  });

  it("rejects a non-ISO occurredAt", () => {
    expect(
      createFinanceEventSchema.safeParse({ ...validEvent, occurredAt: "2026-01-01" }).success,
    ).toBe(false);
  });

  it("rejects a currency string not of length 3", () => {
    expect(createFinanceEventSchema.safeParse({ ...validEvent, currency: "USDO" }).success).toBe(false);
  });

  it("accepts optional unit values", () => {
    for (const unit of ["input_token", "output_token", "request", "credit_usd"]) {
      expect(createFinanceEventSchema.safeParse({ ...validEvent, unit }).success).toBe(true);
    }
  });

  it("accepts a full finance event", () => {
    const full = {
      ...validEvent,
      issueId: "00000000-0000-0000-0000-000000000002",
      projectId: "00000000-0000-0000-0000-000000000003",
      goalId: "00000000-0000-0000-0000-000000000004",
      heartbeatRunId: "00000000-0000-0000-0000-000000000005",
      costEventId: "00000000-0000-0000-0000-000000000006",
      billingCode: "BILL-001",
      description: "Inference charge for agent run",
      direction: "debit",
      provider: "anthropic",
      executionAdapterType: "claude_local",
      pricingTier: "standard",
      region: "us-east-1",
      model: "claude-3-5-sonnet",
      quantity: 1000,
      unit: "input_token",
      currency: "USD",
      estimated: false,
      externalInvoiceId: "inv-001",
      metadataJson: { runId: "run-123" },
    };
    expect(createFinanceEventSchema.safeParse(full).success).toBe(true);
  });
});
