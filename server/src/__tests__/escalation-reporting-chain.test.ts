import { describe, expect, it } from "vitest";

// TSMC-21870, operator directive 2026-08-27: escalations follow the REPORTING LINE —
// Engineer -> CTO -> CEO -> operator — instead of a single hand-set field per company.
//
// That field had drifted into four shapes across eight companies (engineer x2, general x4,
// pm x1, and a devops SHELL HANDLER for Media that the eligibility bar correctly refuses,
// leaving Media with no path above the operator at all).

const LADDER = ["cto", "ceo"] as const;

function nextRungsForRole(role: string | null | undefined): readonly string[] {
  const n = (role ?? "").toLowerCase();
  if (n === "ceo") return [];
  if (n === "cto") return ["ceo"];
  return LADDER;
}

describe("escalation reporting chain", () => {
  it("an engineer's stalled decision goes to the CTO first", () => {
    expect(nextRungsForRole("engineer")).toEqual(["cto", "ceo"]);
  });

  it("a CTO escalates to the CEO, never sideways to another CTO", () => {
    expect(nextRungsForRole("cto")).toEqual(["ceo"]);
  });

  it("above the CEO is the operator — the chain ends, it does not loop", () => {
    expect(nextRungsForRole("ceo")).toEqual([]);
  });

  it("every non-executive role escalates via the CTO", () => {
    for (const role of ["engineer", "designer", "qa", "devops", "researcher", "general", "pm", "cmo"]) {
      expect(nextRungsForRole(role), role).toEqual(["cto", "ceo"]);
    }
  });

  it("an unknown or missing role still escalates rather than parking on the operator", () => {
    expect(nextRungsForRole(null)).toEqual(["cto", "ceo"]);
    expect(nextRungsForRole("")).toEqual(["cto", "ceo"]);
    expect(nextRungsForRole("some-new-role")).toEqual(["cto", "ceo"]);
  });

  it("the ladder ascends and never revisits a rung — no escalation loops", () => {
    for (const role of ["engineer", "cto", "ceo"]) {
      const rungs = nextRungsForRole(role);
      expect(new Set(rungs).size).toBe(rungs.length);
      expect(rungs).not.toContain(role.toLowerCase());
    }
  });
});
