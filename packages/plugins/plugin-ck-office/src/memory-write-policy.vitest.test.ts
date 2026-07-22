import { describe, expect, it } from "vitest";
import { initialMemoryStatus, normalizeMemoryWrite } from "./memory-write-policy.js";

describe("memory write policy", () => {
  it("accepts a stable durable fact", () => {
    expect(
      normalizeMemoryWrite({
        key: "venue:hotel-walther:contact-preference",
        value: "The venue prefers contact by email.",
        mode: "fact",
      }),
    ).toEqual({
      ok: true,
      input: {
        key: "venue:hotel-walther:contact-preference",
        value: "The venue prefers contact by email.",
        mode: "fact",
      },
    });
  });

  it.each([
    [{ value: "Need to determine PAPERCLIP_TASK_ID before queueing." }, /key is required/i],
    [
      { key: "draft-run-2026-07-19", value: "Draft gate-passed and queued for approval." },
      /date stamp|transient task progress/i,
    ],
    [
      { key: "current_task_id_attempt", value: "Attempting to query localhost for the issue id." },
      /transient task progress/i,
    ],
  ])("rejects transient workflow memory %#", (input, expected) => {
    const result = normalizeMemoryWrite(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(expected);
  });

  it("accepts changing workflow state only as a stable checkpoint", () => {
    expect(
      normalizeMemoryWrite({
        key: "outreach:last-reviewed-account",
        value: "Working on account 6a3b62038f0466286.",
        mode: "checkpoint",
      }),
    ).toMatchObject({
      ok: true,
      input: { key: "outreach:last-reviewed-account", mode: "checkpoint" },
    });
    expect(initialMemoryStatus("checkpoint")).toBe("verified");
    expect(initialMemoryStatus("fact")).toBe("unverified");
  });
});
