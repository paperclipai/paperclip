import { describe, expect, it } from "vitest";
import { matchBlockerOwnerAgent } from "./blocker-owner.js";

const lead = { id: "00000000-0000-4000-8000-000000000101", name: "Release Desk Lead" };
const writer = { id: "00000000-0000-4000-8000-000000000102", name: "Writer" };
const rows = [lead, writer];

describe("matchBlockerOwnerAgent", () => {
  it.each([
    ["exact ID", lead.id],
    ["full name", "Release Desk Lead"],
    ["name in another case", "release desk lead"],
    ["name initials", "RDL"],
  ])("resolves an agent by %s", (_label, reference) => {
    expect(matchBlockerOwnerAgent(rows, reference)).toEqual({ agentId: lead.id });
  });

  it("does not resolve an unknown name or another company's ID", () => {
    expect(matchBlockerOwnerAgent(rows, "Nonexistent Reviewer")).toEqual({ agentId: null, ambiguous: false });
    expect(matchBlockerOwnerAgent(rows, "00000000-0000-4000-8000-000000000999")).toEqual({ agentId: null, ambiguous: false });
  });

  it("reports an ambiguous name instead of picking one agent", () => {
    const twin = { id: "00000000-0000-4000-8000-000000000103", name: "Regional Desk Lead" };
    expect(matchBlockerOwnerAgent([...rows, twin], "RDL")).toEqual({ agentId: null, ambiguous: true });
  });

  it("prefers a full-name match over another agent's initials", () => {
    const short = { id: "00000000-0000-4000-8000-000000000104", name: "RDL" };
    expect(matchBlockerOwnerAgent([...rows, short], "RDL")).toEqual({ agentId: short.id });
  });
});
