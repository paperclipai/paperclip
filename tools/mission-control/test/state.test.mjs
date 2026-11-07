import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCompanyState, deriveLaneStatus } from "../src/state.mjs";

test("normalizes an agent graph from Paperclip agent status fields", () => {
  const state = normalizeCompanyState({
    company: { id: "c1", name: "BrainPulse Ventures LLC" },
    agents: [{ id: "a1", name: "Summarizer", status: "idle" }],
    routines: [{ id: "r1", title: "Daily brief", status: "active", triggers: [] }],
    issues: [],
    approvals: [],
    dashboard: null,
    now: new Date("2026-08-31T15:00:00Z"),
  });
  assert.equal(state.company.name, "BrainPulse Ventures LLC");
  assert.equal(state.agents[0].health, "healthy");
  assert.equal(state.routines[0].status, "active");
});

test("redacts nested trigger fields and normalizes missing source data", () => {
  const state = normalizeCompanyState({
    routines: [{
      id: "r1",
      triggers: [{
        id: "t1",
        type: "webhook",
        status: "active",
        config: { token: "do-not-leak", nested: { password: "also-secret" } },
      }],
    }],
    approvals: [{ id: "approval-1" }],
    issues: [{ id: "issue-1" }],
  });

  assert.deepEqual(state.routines[0].triggers, [{ id: "t1", type: "webhook", status: "active" }]);
  assert.equal(JSON.stringify(state).includes("do-not-leak"), false);
  assert.equal(state.routines[0].title, "Unknown");
  assert.equal(state.decisions[0].title, "Unknown");
  assert.equal(state.decisions[0].protected, "Unknown");
  assert.equal(state.timeline[0].identifier, "Unknown");
  assert.equal(state.timeline[0].title, "Unknown");
  assert.equal(state.timeline[0].link, "/issues/issue-1");
});

test("uses Unknown links when source identifiers are missing", () => {
  const state = normalizeCompanyState({
    agents: [{}],
    routines: [{ triggers: [] }],
    approvals: [{}],
    issues: [{}],
  });

  assert.equal(state.agents[0].link, "Unknown");
  assert.equal(state.routines[0].link, "Unknown");
  assert.equal(state.decisions[0].link, "Unknown");
  assert.equal(state.timeline[0].link, "Unknown");
});

test("derives protected owner boundaries from real-shaped Paperclip approval types", () => {
  const state = normalizeCompanyState({
    approvals: [
      {
        id: "approval-budget",
        type: "budget_override_required",
        status: "pending",
        createdAt: "2026-08-31T14:00:00.000Z",
        updatedAt: "2026-08-31T14:05:00.000Z",
        payload: { budgetAmount: 1000, apiKey: "synthetic-secret-must-not-copy" },
      },
      {
        id: "approval-board",
        type: "request_board_approval",
        status: "pending",
        createdAt: "2026-08-31T14:01:00.000Z",
        updatedAt: "2026-08-31T14:06:00.000Z",
        payload: { summary: "Synthetic owner decision", token: "synthetic-token-must-not-copy" },
      },
      {
        id: "approval-future",
        type: "future_approval_type",
        status: "pending",
        createdAt: "2026-08-31T14:02:00.000Z",
        updatedAt: "2026-08-31T14:07:00.000Z",
        payload: { secret: "synthetic-secret-must-not-copy" },
      },
    ],
  });

  assert.equal(state.decisions[0].protected, true);
  assert.equal(state.decisions[1].protected, true);
  assert.equal(state.decisions[2].protected, "Unknown");
  assert.equal(JSON.stringify(state).includes("synthetic-secret-must-not-copy"), false);
  assert.equal(JSON.stringify(state).includes("synthetic-token-must-not-copy"), false);
});

test("derives lane status from health override then agent health", () => {
  assert.equal(deriveLaneStatus({ id: "a1", health: "attention" }, { a1: "healthy" }), "healthy");
  assert.equal(deriveLaneStatus({ id: "a1", health: "blocked" }), "blocked");
  assert.equal(deriveLaneStatus({ id: "a1" }), "unknown");
});

test("maps invalid upstream lane health to unknown", () => {
  assert.equal(deriveLaneStatus({ id: "a1", health: "healthy" }, { a1: "degraded" }), "unknown");
  assert.equal(deriveLaneStatus({ id: "a1", health: "degraded" }), "unknown");
});
