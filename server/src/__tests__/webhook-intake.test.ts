import { describe, expect, it } from "vitest";
import { mapIntakePayload } from "../routes/webhook-intake.ts";

describe("mapIntakePayload", () => {
  it("maps a GitHub issue webhook payload", () => {
    const mapped = mapIntakePayload({
      action: "opened",
      issue: {
        title: "Bug: login fails",
        body: "Steps to reproduce...",
        html_url: "https://github.com/org/repo/issues/42",
      },
    });
    expect(mapped).toEqual({
      title: "Bug: login fails",
      description: "Steps to reproduce...",
      sourceRef: "https://github.com/org/repo/issues/42",
      requiredWorkProductType: "pull_request",
    });
  });

  it("generic payload can carry requiredWorkProductType and maxCostCents", () => {
    const mapped = mapIntakePayload({
      title: "Research task",
      requiredWorkProductType: "research_report",
      maxCostCents: 500,
    });
    expect(mapped).toMatchObject({ requiredWorkProductType: "research_report", maxCostCents: 500 });
    // and no default when not provided
    expect(mapIntakePayload({ title: "Plain" }).requiredWorkProductType).toBeUndefined();
  });

  it("maps a generic payload with priority and sourceRef", () => {
    const mapped = mapIntakePayload({
      title: "Support ticket",
      body: "Customer reports X",
      priority: "high",
      sourceRef: "zendesk:123",
    });
    expect(mapped).toEqual({
      title: "Support ticket",
      description: "Customer reports X",
      priority: "high",
      sourceRef: "zendesk:123",
    });
  });

  it("defaults description and sourceRef to null on a minimal payload", () => {
    const mapped = mapIntakePayload({ title: "Just a title" });
    expect(mapped).toEqual({ title: "Just a title", description: null, sourceRef: null });
  });

  it("rejects payloads without a usable title", () => {
    expect(() => mapIntakePayload({})).toThrow(/Intake payload/);
    expect(() => mapIntakePayload({ title: "   " })).toThrow(/Intake payload/);
    expect(() => mapIntakePayload({ issue: { body: "no title" } })).toThrow(/Intake payload/);
  });

  it("rejects invalid priority values", () => {
    expect(() => mapIntakePayload({ title: "x", priority: "urgent" })).toThrow(/Intake payload/);
  });
});
