import { describe, expect, it } from "vitest";
import { sidebarOrderPreferenceSchema, upsertSidebarOrderPreferenceSchema } from "./sidebar-preferences.js";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// ============================================================================
// sidebarOrderPreferenceSchema
// ============================================================================

describe("sidebarOrderPreferenceSchema", () => {
  it("accepts a valid object with UUID orderedIds and null updatedAt", () => {
    const result = sidebarOrderPreferenceSchema.safeParse({
      orderedIds: [VALID_UUID],
      updatedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty orderedIds array", () => {
    const result = sidebarOrderPreferenceSchema.safeParse({
      orderedIds: [],
      updatedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts multiple UUIDs in orderedIds", () => {
    const result = sidebarOrderPreferenceSchema.safeParse({
      orderedIds: [VALID_UUID, VALID_UUID_2],
      updatedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("coerces ISO date string to Date for updatedAt", () => {
    const result = sidebarOrderPreferenceSchema.safeParse({
      orderedIds: [],
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.updatedAt).toBeInstanceOf(Date);
    }
  });

  it("rejects non-UUID strings in orderedIds", () => {
    const result = sidebarOrderPreferenceSchema.safeParse({
      orderedIds: ["not-a-uuid"],
      updatedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing orderedIds", () => {
    const result = sidebarOrderPreferenceSchema.safeParse({ updatedAt: null });
    expect(result.success).toBe(false);
  });

  it("rejects missing updatedAt", () => {
    const result = sidebarOrderPreferenceSchema.safeParse({ orderedIds: [] });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// upsertSidebarOrderPreferenceSchema
// ============================================================================

describe("upsertSidebarOrderPreferenceSchema", () => {
  it("accepts valid UUID array", () => {
    const result = upsertSidebarOrderPreferenceSchema.safeParse({
      orderedIds: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty orderedIds", () => {
    const result = upsertSidebarOrderPreferenceSchema.safeParse({ orderedIds: [] });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID orderedIds", () => {
    const result = upsertSidebarOrderPreferenceSchema.safeParse({
      orderedIds: ["bad-id"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing orderedIds field", () => {
    const result = upsertSidebarOrderPreferenceSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
