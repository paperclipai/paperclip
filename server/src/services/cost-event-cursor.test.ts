import { describe, expect, it } from "vitest";
import type { BillingType } from "@paperclipai/shared";
import {
  decodeCostEventCursor,
  encodeCostEventCursor,
  normalizeCostEventCursorFilters,
} from "./cost-event-cursor.js";

const occurredAt = "2026-07-15T01:02:03.000Z";
const id = "00000000-0000-4000-8000-000000000003";
const from = new Date("2026-07-01T00:00:00.000Z");
const to = new Date("2026-07-15T23:59:59.999Z");

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function expectCursorError(cursor: string, expectedFilters: ReturnType<typeof normalizeCostEventCursorFilters>, message: string) {
  try {
    decodeCostEventCursor(cursor, expectedFilters);
    throw new Error("Expected cursor decoding to fail");
  } catch (error) {
    expect(error).toMatchObject({ status: 400, message });
    expect((error as Error).message).not.toContain(cursor);
  }
}

describe("cost event cursor", () => {
  it("round trips a version-1 position", () => {
    const filters = normalizeCostEventCursorFilters({ from, to });
    const cursor = encodeCostEventCursor(filters, { occurredAt, id });

    expect(decodeCostEventCursor(cursor, filters)).toEqual({ occurredAt, id });
    expect(decodeCostEventCursor(undefined, filters)).toBeNull();
  });

  it("sorts and deduplicates billing types before encoding", () => {
    const billingTypes: BillingType[] = ["unknown", "metered_api", "unknown", "credits"];
    const filters = normalizeCostEventCursorFilters({ billingTypes });
    const cursor = encodeCostEventCursor(filters, { occurredAt, id });
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

    expect(filters.billingTypes).toEqual(["credits", "metered_api", "unknown"]);
    expect(payload.filters.billingTypes).toEqual(["credits", "metered_api", "unknown"]);
  });

  it("matches equivalent billing-type filters regardless of request ordering", () => {
    const encodedFilters = normalizeCostEventCursorFilters({
      billingTypes: ["unknown", "metered_api"],
    });
    const expectedFilters = normalizeCostEventCursorFilters({
      billingTypes: ["metered_api", "unknown", "metered_api"],
    });
    const cursor = encodeCostEventCursor(encodedFilters, { occurredAt, id });

    expect(decodeCostEventCursor(cursor, expectedFilters)).toEqual({ occurredAt, id });
  });

  it.each([
    normalizeCostEventCursorFilters({ from: new Date("2026-07-02T00:00:00.000Z"), to, billingTypes: ["metered_api"] }),
    normalizeCostEventCursorFilters({ from, to: new Date("2026-07-14T23:59:59.999Z"), billingTypes: ["metered_api"] }),
    normalizeCostEventCursorFilters({ from, to, billingTypes: ["credits"] }),
  ])("rejects a cursor when request filters change", (changedFilters) => {
    const filters = normalizeCostEventCursorFilters({ from, to, billingTypes: ["metered_api"] });
    const cursor = encodeCostEventCursor(filters, { occurredAt, id });

    expectCursorError(cursor, changedFilters, "Cost-events cursor does not match request filters");
  });

  it("does not bind cursor validity to a page limit", () => {
    const firstPageLimit = 10;
    const secondPageLimit = 500;
    const filters = normalizeCostEventCursorFilters({ from, billingTypes: ["metered_api"] });
    const cursor = encodeCostEventCursor(filters, { occurredAt, id });

    expect(firstPageLimit).not.toBe(secondPageLimit);
    expect(decodeCostEventCursor(cursor, filters)).toEqual({ occurredAt, id });
  });

  it.each([
    ["invalid base64", "%%%"],
    ["invalid JSON", Buffer.from("not-json", "utf8").toString("base64url")],
    ["unsupported version", rawCursor({
      v: 2,
      filters: { from: null, to: null, billingTypes: [] },
      position: { occurredAt, id },
    })],
    ["invalid date", rawCursor({
      v: 1,
      filters: { from: null, to: null, billingTypes: [] },
      position: { occurredAt: "not-a-date", id },
    })],
    ["invalid UUID", rawCursor({
      v: 1,
      filters: { from: null, to: null, billingTypes: [] },
      position: { occurredAt, id: "not-a-uuid" },
    })],
    ["oversized input", "x".repeat(4097)],
  ])("rejects %s without echoing supplied content", (_label, cursor) => {
    expectCursorError(
      cursor,
      normalizeCostEventCursorFilters({}),
      "Invalid cost-events cursor",
    );
  });
});
