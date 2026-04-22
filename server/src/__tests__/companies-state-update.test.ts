import { describe, expect, it } from "vitest";
import { resolveCompanyStateUpdatePatch } from "../services/companies.ts";

describe("resolveCompanyStateUpdatePatch", () => {
  it("assigns a manual pause reason and timestamp when a company is paused", () => {
    const now = new Date("2026-04-22T15:40:00.000Z");

    const patch = resolveCompanyStateUpdatePatch(
      {
        status: "active",
        pauseReason: null,
        pausedAt: null,
      },
      {
        status: "paused",
      },
      now,
    );

    expect(patch).toEqual({
      status: "paused",
      pauseReason: "manual",
      pausedAt: now,
    });
  });

  it("clears pause metadata when a manually paused company resumes", () => {
    const patch = resolveCompanyStateUpdatePatch(
      {
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-04-22T15:40:00.000Z"),
      },
      {
        status: "active",
      },
    );

    expect(patch).toEqual({
      status: "active",
      pauseReason: null,
      pausedAt: null,
    });
  });

  it("rejects resuming a budget-paused company through the generic update flow", () => {
    expect(() =>
      resolveCompanyStateUpdatePatch(
        {
          status: "paused",
          pauseReason: "budget",
          pausedAt: new Date("2026-04-22T15:40:00.000Z"),
        },
        {
          status: "active",
        },
      ),
    ).toThrow("Budget-paused companies must be resumed from Costs");
  });

  it("clears pause metadata when archiving a paused company", () => {
    const patch = resolveCompanyStateUpdatePatch(
      {
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-04-22T15:40:00.000Z"),
      },
      {
        status: "archived",
      },
    );

    expect(patch).toEqual({
      status: "archived",
      pauseReason: null,
      pausedAt: null,
    });
  });
});
