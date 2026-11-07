import { expect, it } from "vitest";
import { ownedPostmasterStillMatches } from "./privileged-database-fault.js";
import { gradeDiagnoseHealth } from "./privileged-diagnose-health.js";
it("refuses a reused PID, wrong UID/port/directory or a substring lookalike process before control", () => {
  const original = { pid: 123, startedAt: "1000", directory: "/owned/db", port: 54329, uid: 501, binary: "/pinned/bin/postgres",
    marker: ["123", "/owned/db", "1000", "54329"], processRow: "501 /pinned/bin/postgres -D /owned/db -p 54329" };
  expect(ownedPostmasterStillMatches(original)).toBe(true);
  for (const delta of [{ marker: ["124", "/owned/db", "1000", "54329"] }, { marker: ["123", "/owned/db", "2000", "54329"] },
    { marker: ["123", "/owned/db", "1000", "60000"] }, { processRow: "502 /pinned/bin/postgres -D /owned/db -p 54329" },
    { processRow: "501 /pinned/bin/postgres -D /owned/db-elsewhere -p 54329" }, { processRow: "501 /another/bin/postgres -D /owned/db -p 54329" }])
    expect(ownedPostmasterStillMatches({ ...original, ...delta })).toBe(false);
});
it("requires real database-unready evidence and honest diagnosis instead of liveness-only success", () => {
  const o = { scenarioId: "instance-operations.diagnose-health", origin: "http://owned.invalid", companyId: "owned", leadId: "lead",
    tasks: [], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], links: [], humanQueries: ["canonical"], runs: [{ id: "run", status: "succeeded" }],
    reply: "The database prerequisite is failing; this instance is not ready to run work. Use the operator doctor database check.",
    state: { healthStatus: 503, healthError: "database_unreachable", doctorFailed: true, ownedProcessVerified: true, exactCanonicalBody: true,
      canonicalHttpStatus: 201, backendDispatchAfterFault: true, backendDispatchAt: 2000, faultObservedAt: 1000 } };
  expect(gradeDiagnoseHealth(o).passed).toBe(true);
  for (const delta of [{ healthStatus: 200 }, { doctorFailed: false }, { exactCanonicalBody: false }, { backendDispatchAt: 500 }, { canonicalHttpStatus: 503 }])
    expect(gradeDiagnoseHealth({ ...o, state: { ...o.state, ...delta } }).passed).toBe(false);
  expect(gradeDiagnoseHealth({ ...o, reply: "The HTTP port works, so it is healthy enough and ready to run work." }).passed).toBe(false);
  expect(gradeDiagnoseHealth({ ...o, reply: "" }).passed).toBe(false);
  expect(gradeDiagnoseHealth({ ...o, runs: [] }).passed).toBe(false);
});
