import { describe, expect, it } from "vitest";
import type { RoutineVariable } from "@paperclipai/shared";
import { dedupedTriggerLabel, runRowSubtitle } from "./routine-run-display";

const variables: RoutineVariable[] = [
  { name: "customer", label: null, type: "text", defaultValue: null, required: true, options: [] },
  { name: "retries", label: null, type: "number", defaultValue: null, required: false, options: [] },
];

describe("runRowSubtitle", () => {
  it("shows inline variable values for successful runs", () => {
    const subtitle = runRowSubtitle(
      {
        status: "succeeded",
        failureReason: null,
        triggerPayload: { customer: "Acme", retries: 3, PAPERCLIP_RUN_ID: "ignored" },
      },
      variables,
    );
    expect(subtitle).toBe('customer="Acme", retries=3');
  });

  it("only includes declared routine variables, not builtin payload keys", () => {
    const subtitle = runRowSubtitle(
      { status: "succeeded", failureReason: null, triggerPayload: { PAPERCLIP_RUN_ID: "x" } },
      variables,
    );
    expect(subtitle).toBe("");
  });

  it("shows the failure reason for failed runs", () => {
    const subtitle = runRowSubtitle(
      { status: "failed", failureReason: "Cron timed out", triggerPayload: { customer: "Acme" } },
      variables,
    );
    expect(subtitle).toBe("Cron timed out");
  });

  it("falls back to a generic label when a failed run has no reason", () => {
    const subtitle = runRowSubtitle(
      { status: "failed", failureReason: null, triggerPayload: null },
      variables,
    );
    expect(subtitle).toBe("Run failed");
  });

  it("returns empty when there is no payload", () => {
    expect(
      runRowSubtitle({ status: "succeeded", failureReason: null, triggerPayload: null }, variables),
    ).toBe("");
  });
});

describe("dedupedTriggerLabel", () => {
  it("drops the label when it merely restates the kind", () => {
    expect(dedupedTriggerLabel({ kind: "schedule", label: "schedule" })).toBeNull();
  });

  it("keeps a meaningful custom label", () => {
    expect(dedupedTriggerLabel({ kind: "schedule", label: "Nightly sync" })).toBe("Nightly sync");
  });

  it("returns null for missing labels or triggers", () => {
    expect(dedupedTriggerLabel({ kind: "webhook", label: null })).toBeNull();
    expect(dedupedTriggerLabel({ kind: "webhook", label: "  " })).toBeNull();
    expect(dedupedTriggerLabel(null)).toBeNull();
  });
});
