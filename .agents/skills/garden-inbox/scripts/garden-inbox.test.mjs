import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedCandidates,
  archiveTargetBody,
  classify,
  confirmationBody,
  decodeJwtPayload,
  fetchMineInboxRows,
  normalizeApiBase,
} from "./garden-inbox.mjs";

const now = new Date("2026-07-29T00:00:00.000Z");

function issue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    title: "Example",
    status: "done",
    updatedAt: "2025-01-01T00:00:00.000Z",
    blockedBy: [],
    ...overrides,
  };
}

function workspace(overrides = {}) {
  return {
    gone: false,
    error: null,
    status: "active",
    branchCommitAt: "2025-01-01T00:00:00.000Z",
    readiness: {
      git: { isMergedIntoBase: false, aheadCount: 0 },
      linkedIssues: [{ isTerminal: true }],
    },
    ...overrides,
  };
}

test("classifies each archive and keep condition into one bucket", () => {
  const merged = workspace({
    readiness: {
      git: { isMergedIntoBase: true, aheadCount: 0 },
      linkedIssues: [{ isTerminal: true }],
    },
  });
  assert.equal(classify(issue(), merged, 60, now).bucket, "A");
  assert.equal(classify(issue(), workspace(), 60, now).bucket, "B");
  assert.equal(classify(issue(), workspace({
    readiness: {
      git: { isMergedIntoBase: false, aheadCount: 2 },
      linkedIssues: [{ isTerminal: true }],
    },
  }), 60, now).bucket, "C");
  assert.equal(classify(issue({ status: "in_progress" }), workspace(), 60, now).bucket, "D");
});

test("keeps candidates when workspace safety inspection fails", () => {
  const result = classify(issue(), workspace({ error: "503 Service Unavailable", readiness: null }), 60, now);
  assert.equal(result.bucket, "D");
  assert.equal(result.reason.code, "workspace_inspection_failed");
});

test("returns only accepted options from the originating scan", () => {
  const candidate = { issueId: "issue-1", bucket: "A" };
  const scan = { scanId: "scan-1" };
  const interaction = {
    id: "interaction-1",
    kind: "request_checkbox_confirmation",
    idempotencyKey: "garden-inbox:scan-1:1:1",
    status: "accepted",
    payload: { options: [{ id: "issue-1" }] },
    result: { outcome: "accepted", selectedOptionIds: ["issue-1"] },
  };
  assert.deepEqual(acceptedCandidates(interaction, scan, new Map([[candidate.issueId, candidate]])), [candidate]);
});

test("unselected candidates start unchecked and are labelled as previously declined", () => {
  const scan = { scanId: "scan-1", staleDays: 60 };
  const candidates = [
    { issueId: "issue-1", identifier: "PAP-1", title: "Kept before", bucket: "B", lastActivityAt: "2026-05-01T00:00:00.000Z", reason: { message: "Stale." } },
    { issueId: "issue-2", identifier: "PAP-2", title: "New candidate", bucket: "B", lastActivityAt: "2026-05-01T00:00:00.000Z", reason: { message: "Stale." } },
  ];
  const body = confirmationBody(scan, candidates, 0, 1, new Set(["issue-1"]));
  assert.deepEqual(body.payload.defaultSelectedOptionIds, ["issue-2"]);
  assert.match(body.payload.options[0].description, /Declined in a previous pass; starts unchecked\./);
  assert.doesNotMatch(body.payload.options[1].description, /Declined in a previous pass/);
  assert.notEqual(body.idempotencyKey, "garden-inbox:scan-1:1:1");
  assert.equal(
    body.idempotencyKey,
    confirmationBody(scan, candidates, 0, 1, new Set(["issue-1"])).idempotencyKey,
  );
  assert.notEqual(
    body.idempotencyKey,
    confirmationBody(scan, candidates, 0, 1, new Set(["issue-2"])).idempotencyKey,
  );
  assert.equal(
    confirmationBody(scan, candidates, 0, 1).idempotencyKey,
    "garden-inbox:scan-1:1:1",
  );
  assert.equal(
    confirmationBody(scan, [candidates[1]], 1, 2, new Set(["issue-1"])).idempotencyKey,
    "garden-inbox:scan-1:2:2",
  );
});

test("preserves an overridden scan user for archive and undo requests", () => {
  assert.deepEqual(archiveTargetBody({ userId: "target-user" }), { userId: "target-user" });
});

test("rejects selected ids that were not offered", () => {
  const scan = { scanId: "scan-1" };
  const interaction = {
    id: "interaction-1",
    kind: "request_checkbox_confirmation",
    idempotencyKey: "garden-inbox:scan-1:1:1",
    status: "accepted",
    payload: { options: [{ id: "issue-1" }] },
    result: { outcome: "accepted", selectedOptionIds: ["issue-2"] },
  };
  assert.throws(
    () => acceptedCandidates(interaction, scan, new Map()),
    /was not an option in the interaction/,
  );
});

test("decodes the responsible user and normalizes API URLs locally", () => {
  const payload = Buffer.from(JSON.stringify({ responsible_user_id: "user-1" })).toString("base64url");
  assert.equal(decodeJwtPayload(`header.${payload}.signature`).responsible_user_id, "user-1");
  assert.equal(normalizeApiBase("https://paperclip.example/api/"), "https://paperclip.example");
});

test("scans Mine once per status and merges rows by issue id", async (t) => {
  const requestedStatuses = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    const status = parsed.searchParams.get("status");
    requestedStatuses.push(status);
    const rows = status === "todo"
      ? [issue({ id: "shared", status: "todo" })]
      : status === "done"
        ? [issue({ id: "shared", status: "done" }), issue({ id: "done-only" })]
        : [];
    return new Response(JSON.stringify(rows), { status: 200 });
  });

  const result = await fetchMineInboxRows({
    apiBase: "https://paperclip.example",
    apiKey: "secret",
  }, "user-1");

  assert.deepEqual(requestedStatuses, ["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find((row) => row.id === "shared").status, "done");
  assert.equal(result.coverage.duplicateCount, 1);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.coverage.statusCounts, {
    backlog: 0,
    todo: 1,
    in_progress: 0,
    in_review: 0,
    blocked: 0,
    done: 2,
  });
});

test("warns when an individual status query reaches the Mine endpoint cap", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const status = new URL(url).searchParams.get("status");
    const rows = status === "done"
      ? Array.from({ length: 500 }, (_, index) => issue({ id: `done-${index}` }))
      : [];
    return new Response(JSON.stringify(rows), { status: 200 });
  });

  const result = await fetchMineInboxRows({
    apiBase: "https://paperclip.example",
    apiKey: "secret",
  }, "user-1");

  assert.equal(result.rows.length, 500);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.cappedStatuses, ["done"]);
  assert.equal(result.coverage.queryCap, 500);
});
