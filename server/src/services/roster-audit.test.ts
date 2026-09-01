import { describe, expect, it } from "vitest";
import { auditRoster, parseRosterManifest } from "./roster-audit.js";

describe("roster audit", () => {
  it("reports drift without recommending destructive actions", () => {
    const report = auditRoster(
      [{ id: "repo-1", name: "CEO", role: "lead" }, { name: "Missing", role: "engineer" }],
      [
        { id: "repo-1", name: "CEO", role: "lead", status: "idle", hasCostHistory: true },
        { id: "db-1", name: "Live", role: "engineer", status: "error", hasCostHistory: false },
      ],
    );
    expect(report.repoOnlyAgents).toHaveLength(1);
    expect(report.dbOnlyAgents).toHaveLength(1);
    expect(report.agentsWithNoCostHistory).toHaveLength(1);
    expect(report.agentsInError).toHaveLength(1);
    expect(report.remediation.action).toBe("operator_review_only");
  });

  it("counts a matched agent once, so a roster that agrees reports no duplicate role", () => {
    const report = auditRoster(
      [{ id: "a-1", name: "CEO", role: "lead" }, { name: "Engineer", role: "engineer" }],
      [
        { id: "a-1", name: "CEO", role: "lead", status: "idle", hasCostHistory: true },
        { id: "a-2", name: "Engineer", role: "engineer", status: "idle", hasCostHistory: true },
      ],
    );
    expect(report.duplicateRoleFamilies).toEqual([]);
    expect(report.repoOnlyAgents).toEqual([]);
    expect(report.dbOnlyAgents).toEqual([]);
  });

  it("still reports a role two distinct agents hold", () => {
    const report = auditRoster(
      [{ id: "a-1", name: "First", role: "engineer" }],
      [
        { id: "a-1", name: "First", role: "engineer", status: "idle", hasCostHistory: true },
        { id: "a-2", name: "Second", role: "Engineer", status: "idle", hasCostHistory: true },
      ],
    );
    expect(report.duplicateRoleFamilies).toEqual([{ role: "engineer", count: 2 }]);
  });

  it("reports a stale manifest id on both sides, even when the name still agrees", () => {
    const report = auditRoster(
      [{ id: "stale-id", name: "CEO", role: "lead" }],
      [{ id: "live-id", name: "CEO", role: "lead", status: "idle", hasCostHistory: true }],
    );
    expect(report.repoOnlyAgents).toEqual([{ id: "stale-id", name: "CEO", role: "lead" }]);
    expect(report.dbOnlyAgents.map((agent) => agent.id)).toEqual(["live-id"]);
  });

  it("reports a manifest that lists one agent twice, by id or by name", () => {
    const byId = auditRoster(
      [{ id: "a-1", name: "CEO", role: "lead" }, { id: "a-1", name: "CEO copy", role: "lead" }],
      [{ id: "a-1", name: "CEO", role: "lead", status: "idle", hasCostHistory: true }],
    );
    expect(byId.repoOnlyAgents).toEqual([{ id: "a-1", name: "CEO copy", role: "lead" }]);
    expect(byId.dbOnlyAgents).toEqual([]);
    expect(byId.duplicateRoleFamilies).toEqual([{ role: "lead", count: 2 }]);

    const byName = auditRoster(
      [{ name: "CEO", role: "lead" }, { name: " ceo ", role: "lead" }],
      [{ id: "a-1", name: "CEO", role: "lead", status: "idle", hasCostHistory: true }],
    );
    expect(byName.repoOnlyAgents).toEqual([{ name: " ceo ", role: "lead" }]);
    expect(byName.dbOnlyAgents).toEqual([]);
    expect(byName.duplicateRoleFamilies).toEqual([{ role: "lead", count: 2 }]);
  });

  it("matches on name only when one live agent carries it", () => {
    const ambiguous = auditRoster(
      [{ name: "Engineer", role: "engineer" }],
      [
        { id: "a-1", name: "Engineer", role: "engineer", status: "idle", hasCostHistory: true },
        { id: "a-2", name: "engineer", role: "engineer", status: "idle", hasCostHistory: true },
      ],
    );
    expect(ambiguous.repoOnlyAgents).toHaveLength(1);
    expect(ambiguous.dbOnlyAgents.map((agent) => agent.id)).toEqual(["a-1", "a-2"]);

    const unambiguous = auditRoster(
      [{ name: " engineer " }],
      [{ id: "a-1", name: "Engineer", role: "engineer", status: "idle", hasCostHistory: true }],
    );
    expect(unambiguous.repoOnlyAgents).toEqual([]);
    expect(unambiguous.dbOnlyAgents).toEqual([]);
  });
});

describe("roster manifest validation", () => {
  it("accepts a well formed manifest", () => {
    const result = parseRosterManifest([
      { name: "CEO", id: "a-1", role: "lead" },
      { name: "Engineer", role: null },
      { name: "Designer" },
    ]);
    expect(result).toEqual({
      ok: true,
      manifest: [
        { id: "a-1", name: "CEO", role: "lead" },
        { name: "Engineer", role: null },
        { name: "Designer" },
      ],
    });
  });

  it("refuses a root that is not an array", () => {
    for (const value of [{ name: "CEO" }, "CEO", 7, null]) {
      expect(parseRosterManifest(value)).toEqual({ ok: false, error: "manifest must be a JSON array" });
    }
  });

  it("refuses a member that is not an object", () => {
    expect(parseRosterManifest(["CEO"])).toEqual({ ok: false, error: "manifest entry 0 must be an object" });
    expect(parseRosterManifest([null])).toEqual({ ok: false, error: "manifest entry 0 must be an object" });
    expect(parseRosterManifest([[]])).toEqual({ ok: false, error: "manifest entry 0 must be an object" });
  });

  it("refuses a member whose name, id, or role has the wrong type", () => {
    expect(parseRosterManifest([{ name: 7 }]).ok).toBe(false);
    expect(parseRosterManifest([{ name: "   " }]).ok).toBe(false);
    expect(parseRosterManifest([{ name: "CEO", id: 7 }]).ok).toBe(false);
    expect(parseRosterManifest([{ name: "CEO", id: "" }]).ok).toBe(false);
    // This one reached role.trim() on a number and answered the operator with a 500.
    expect(parseRosterManifest([{ name: "A", role: 123 }])).toEqual({
      ok: false,
      error: "manifest entry 0 must have a role that is a string, or null, or no role",
    });
  });

  it("names the entry that is at fault", () => {
    expect(parseRosterManifest([{ name: "CEO" }, { role: "engineer" }])).toEqual({
      ok: false,
      error: "manifest entry 1 must have a name that is a string and is not empty",
    });
  });
});
