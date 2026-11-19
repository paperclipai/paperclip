import { describe, expect, it } from "vitest";
import {
  chooseResponsibilityReporter,
  responsibilityReporterScore,
  responsibilityStatusReportOutOfDate,
  writeResponsibilityStatusReportSchema,
  type ResponsibilityReporterAgent,
  type ResponsibilityReporterCandidate,
} from "./responsibility-status-reports.js";

const agent = (id: string, overrides: Partial<ResponsibilityReporterAgent> = {}): ResponsibilityReporterAgent => ({
  id, role: "general", reportsTo: "boss", createdAt: `2026-01-0${id.length}T00:00:00Z`, canTakeWork: true, ...overrides,
});
const work = (agentId: string, overrides: Partial<ResponsibilityReporterCandidate> = {}): ResponsibilityReporterCandidate => ({
  agentId, openTasks: 0, routines: 0, ledProjects: 0, runsIt: false, lastActivityAt: null, ...overrides,
});

describe("the reporter rule", () => {
  const ceo = agent("c", { role: "ceo", reportsTo: null, createdAt: "2026-01-05T00:00:00Z" });
  const cto = agent("cto", { reportsTo: "c", createdAt: "2026-01-02T00:00:00Z" });
  const ux = agent("ux", { createdAt: "2026-01-03T00:00:00Z" });

  it("counts open tasks, routines, led projects and running it", () => {
    expect(responsibilityReporterScore({ openTasks: 2, routines: 1, ledProjects: 1, runsIt: true })).toBe(5);
  });

  it("picks the agent doing the most under it", () => {
    expect(chooseResponsibilityReporter([work("ux", { openTasks: 1 }), work("cto", { openTasks: 1, ledProjects: 1 })], [ceo, cto, ux]))
      .toEqual({ agentId: "cto", basis: "works_under" });
  });

  it("breaks a tie by the most recent activity, then by running it, then by who came first", () => {
    const tied = [work("ux", { openTasks: 2, lastActivityAt: "2026-11-10T00:00:00Z" }), work("cto", { openTasks: 2, lastActivityAt: "2026-11-01T00:00:00Z" })];
    expect(chooseResponsibilityReporter(tied, [ceo, cto, ux])?.agentId).toBe("ux");
    const sameTime = [work("ux", { openTasks: 1, routines: 1 }), work("cto", { openTasks: 1, runsIt: true })];
    expect(chooseResponsibilityReporter(sameTime, [ceo, cto, ux])?.agentId).toBe("cto");
    expect(chooseResponsibilityReporter([work("ux", { openTasks: 1 }), work("cto", { openTasks: 1 })], [ceo, cto, ux])?.agentId).toBe("cto");
  });

  it("skips agents that cannot take work", () => {
    expect(chooseResponsibilityReporter([work("cto", { openTasks: 5 }), work("ux", { openTasks: 1 })], [ceo, { ...cto, canTakeWork: false }, ux])?.agentId).toBe("ux");
  });

  it("falls back to the top agent, then the first agent reporting to nobody, then the first agent", () => {
    expect(chooseResponsibilityReporter([], [ceo, cto, ux])).toEqual({ agentId: "c", basis: "top_agent" });
    expect(chooseResponsibilityReporter([work("ux")], [ceo, cto, ux])).toEqual({ agentId: "c", basis: "top_agent" });
    expect(chooseResponsibilityReporter([], [{ ...ceo, role: "general" }, cto, { ...ux, reportsTo: null }])).toEqual({ agentId: "ux", basis: "top_agent" });
    expect(chooseResponsibilityReporter([], [cto, ux])).toEqual({ agentId: "cto", basis: "first_agent" });
    expect(chooseResponsibilityReporter([], [{ ...cto, canTakeWork: false }])).toBeNull();
  });
});

describe("freshness", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  it("is out of date after seven days", () => {
    expect(responsibilityStatusReportOutOfDate("2026-11-10T12:00:00Z", now)).toBe(false);
    expect(responsibilityStatusReportOutOfDate("2026-11-09T11:00:00Z", now)).toBe(true);
    expect(responsibilityStatusReportOutOfDate("2026-11-14T12:00:00Z", now, 1)).toBe(true);
  });
});

describe("what a report may say", () => {
  const parse = (body: object) => writeResponsibilityStatusReportSchema.safeParse(body);
  it("takes a status, one plain line and optional detail", () => {
    expect(parse({ status: "on_track", message: "Twelve straight weeks of improvement." }).success).toBe(true);
    expect(parse({ status: "unknown", message: "No reading since the source changed.", detail: "Checking the new dashboard." }).success).toBe(true);
  });
  it("refuses an author, a bare status, markup and more than one line", () => {
    expect(parse({ status: "on_track", message: "Twelve straight weeks of improvement.", agentId: "a" }).success).toBe(false);
    expect(parse({ status: "on_track", message: "On track" }).success).toBe(false);
    expect(parse({ status: "on_track", message: "See [the chart](http://x)" }).success).toBe(false);
    expect(parse({ status: "on_track", message: "One\nTwo" }).success).toBe(false);
    expect(parse({ status: "on_track", message: "x".repeat(201) }).success).toBe(false);
  });
});
