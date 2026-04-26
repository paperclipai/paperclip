import { describe, expect, it } from "vitest";
import { createAssetImageMetadataSchema } from "./asset.js";

describe("createAssetImageMetadataSchema", () => {
  it("accepts an empty object (namespace is optional)", () => {
    expect(createAssetImageMetadataSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a valid namespace", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "my-org/images" }).success).toBe(true);
  });

  it("accepts namespace with alphanumerics, slashes, underscores, and hyphens", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "org/sub_dir-2" }).success).toBe(true);
  });

  it("rejects namespace over 120 characters", () => {
    expect(
      createAssetImageMetadataSchema.safeParse({ namespace: "a".repeat(121) }).success,
    ).toBe(false);
  });

  it("rejects namespace with spaces", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "my namespace" }).success).toBe(false);
  });

  it("rejects an empty namespace string", () => {
    expect(createAssetImageMetadataSchema.safeParse({ namespace: "" }).success).toBe(false);
  });
});
