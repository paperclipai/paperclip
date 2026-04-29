import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildEmbeddedPostgresHostReadySlice,
  buildReport,
  classifyOwner,
  createEmbeddedPostgresAcceptedDebtAttempt,
  runReleaseHostVerification,
  selectSlicesForRerun,
  summarizeStatus,
} from "./rt2-release-host-verify.mjs";
import {
  DB_SUITES,
  SERVER_ROUTE_SUITES,
  buildHostReadyCommands,
} from "./rt2-embedded-postgres-host-ready.mjs";

assert.equal(classifyOwner({ id: "typecheck" }), "workspace");
assert.equal(classifyOwner({ suite: "server-route" }), "server-route");
assert.equal(classifyOwner({ project: "@paperclipai/ui" }), "ui");
assert.equal(classifyOwner({ project: "@paperclipai/db" }), "db");

const fakeSlices = [
  { id: "slice-pass", suite: "fixture", command: process.execPath, args: ["-e", "process.exit(0)"], phase: "release-host", owner: "fixture" },
  { id: "slice-fail", suite: "fixture", command: process.execPath, args: ["-e", "process.exit(1)"], phase: "release-host", owner: "fixture" },
  { id: "slice-timeout", suite: "fixture", command: process.execPath, args: ["-e", "setTimeout(() => {}, 500)"], phase: "release-host", owner: "fixture" },
];

const summaryForSelection = {
  attempts: [
    { sliceId: "slice-pass", status: "passed" },
    { sliceId: "slice-fail", status: "failed" },
    { sliceId: "slice-timeout", status: "timeout" },
  ],
};
assert.deepEqual(
  selectSlicesForRerun(summaryForSelection, fakeSlices).map((slice) => slice.id),
  ["slice-fail", "slice-timeout"],
);
assert.equal(summarizeStatus(summaryForSelection.attempts), "timeout");
assert.equal(
  summarizeStatus([
    { sliceId: "typecheck", status: "passed" },
    { sliceId: "embedded-postgres-windows-default-skip", status: "accepted_debt" },
  ]),
  "accepted_debt",
);

const acceptedDebt = createEmbeddedPostgresAcceptedDebtAttempt({ attemptNumber: 1, timeoutMs: 1000 });
assert.equal(acceptedDebt.status, "accepted_debt");
assert.equal(acceptedDebt.owner, "db");
assert.equal(acceptedDebt.debt.reasonCode, "windows_default_disabled");
assert.match(buildReport({ status: "accepted_debt", timeoutMs: 1000, updatedAt: "now", runDir: ".", attempts: [acceptedDebt] }), /accepted_debt/);

const embeddedSlice = buildEmbeddedPostgresHostReadySlice();
assert.equal(embeddedSlice.id, "embedded-postgres-host-ready");
assert.equal(embeddedSlice.suite, "embedded-postgres");
assert.ok(embeddedSlice.args.includes("rt2:embedded-postgres-host-ready"));

const hostReadyCommands = buildHostReadyCommands();
assert.equal(hostReadyCommands.length, 2);
assert.ok(DB_SUITES.includes("packages/db/src/rt2-task-persistence.test.ts"));
assert.ok(SERVER_ROUTE_SUITES.includes("server/src/__tests__/rt2-task-routes.test.ts"));
assert.ok(hostReadyCommands.every((command) => command.args.includes("vitest")));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt2-release-host-"));
const evidenceDir = path.join(root, "evidence");
const first = await runReleaseHostVerification({
  root,
  evidenceDir,
  timeoutMs: 100,
  slices: fakeSlices,
});

assert.equal(first.status, "timeout");
assert.equal(first.attempts.length, 3);
assert.ok(first.attempts.some((attempt) => attempt.status === "passed"));
assert.ok(first.attempts.some((attempt) => attempt.status === "failed"));
assert.ok(first.attempts.some((attempt) => attempt.status === "timeout"));
assert.ok(fs.existsSync(path.join(first.runDirAbs, "summary.json")));
assert.ok(fs.existsSync(path.join(first.runDirAbs, "report.md")));
assert.match(buildReport(first), /Retry/);

const loaded = JSON.parse(fs.readFileSync(path.join(first.runDirAbs, "summary.json"), "utf8"));
const rerun = await runReleaseHostVerification({
  root,
  timeoutMs: 100,
  slices: fakeSlices.map((slice) =>
    slice.id === "slice-fail"
      ? { ...slice, args: ["-e", "process.exit(0)"] }
      : slice.id === "slice-timeout"
        ? { ...slice, args: ["-e", "process.exit(0)"] }
        : slice,
  ),
  rerun: true,
  existingSummary: { ...loaded, sourcePath: path.join(first.runDirAbs, "summary.json") },
});

assert.equal(rerun.status, "passed");
assert.equal(rerun.attempts.length, 5);
assert.deepEqual(rerun.selectedSlices, ["slice-fail", "slice-timeout"]);

console.log("rt2-release-host-verify tests passed");
