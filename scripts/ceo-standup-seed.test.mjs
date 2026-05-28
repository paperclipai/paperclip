import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStandupSnapshot,
  extractDeploymentSection,
  latestDeploymentSectionFromComments,
  renderStandupIssueDescription,
  seedCountsFromSnapshot,
  validateSeedCountsAgainstLiveSnapshot,
} from "./ceo-standup-seed.mjs";

function issue(overrides) {
  return {
    id: `issue-${overrides.identifier}`,
    identifier: overrides.identifier,
    title: overrides.title ?? `Issue ${overrides.identifier}`,
    status: overrides.status,
    priority: overrides.priority ?? "medium",
    assigneeAgentId: overrides.assigneeAgentId ?? "cto",
    createdAt: overrides.createdAt ?? "2026-05-01T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-17T12:00:00.000Z",
    completedAt: overrides.completedAt ?? null,
    hiddenAt: null,
    ...overrides,
  };
}

function range(count, factory) {
  return Array.from({ length: count }, (_, index) => factory(index));
}

const agents = [
  { id: "cto", name: "CTO" },
  { id: "ceo", name: "CEO" },
  { id: "qa", name: "QA Engineer" },
];

test("builds the May 25 standup snapshot from live open status membership", () => {
  const issues = [
    ...range(25, (index) => issue({ identifier: `MEA-R${index}`, status: "in_review" })),
    ...range(98, (index) => issue({ identifier: `MEA-B${index}`, status: "blocked", assigneeAgentId: "qa" })),
    ...range(23, (index) => issue({ identifier: `MEA-T${index}`, status: "todo" })),
    issue({ identifier: "MEA-BACKLOG", status: "backlog" }),
    issue({ identifier: "MEA-1043", status: "in_progress", assigneeAgentId: "ceo" }),
    issue({
      identifier: "MEA-OLD-DONE",
      status: "done",
      completedAt: "2026-05-20T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    }),
  ];

  const snapshot = buildStandupSnapshot({
    issues,
    agents,
    now: "2026-05-25T19:07:00.000Z",
  });

  assert.equal(snapshot.counts.open, 148);
  assert.deepEqual(seedCountsFromSnapshot(snapshot), {
    shipped: 0,
    inStaging: 25,
    inProgress: 1,
    blockedOrStale: 98,
    backlog: 24,
  });

  validateSeedCountsAgainstLiveSnapshot(seedCountsFromSnapshot(snapshot), snapshot);
});

test("rejects the former all-zero manual seed when live issues are open", () => {
  const snapshot = buildStandupSnapshot({
    issues: [
      issue({ identifier: "MEA-REVIEW", status: "in_review" }),
      issue({ identifier: "MEA-BLOCKED", status: "blocked" }),
      issue({ identifier: "MEA-TODO", status: "todo" }),
    ],
    agents,
    now: "2026-05-25T19:07:00.000Z",
  });

  assert.throws(
    () => validateSeedCountsAgainstLiveSnapshot({
      shipped: 0,
      inStaging: 0,
      inProgress: 0,
      blockedOrStale: 0,
      backlog: 0,
    }, snapshot),
    /Standup seed counts do not match the live issue snapshot/,
  );
});

test("renders a seed with the canonical deployment section and regression note", () => {
  const snapshot = buildStandupSnapshot({
    issues: [
      issue({ identifier: "MEA-1007", title: "Founder route restore", status: "in_review" }),
      issue({ identifier: "MEA-993", title: "Preview token fix", status: "blocked" }),
      issue({ identifier: "MEA-935", title: "Claim resume continuity", status: "todo" }),
    ],
    agents,
    now: "2026-05-25T19:07:00.000Z",
  });

  const rendered = renderStandupIssueDescription(snapshot, {
    sourceIssueIdentifier: "MEA-1043",
    section: "**DEPLOYMENTS**\n\n**PRODUCTION**\n- No production deployment record landed.",
  });

  assert.match(rendered, /OPEN ISSUE STATUS COUNTS: in_review=1, blocked=1, todo\/backlog=1, in_progress=0, open_total=3/);
  assert.match(rendered, /DEPLOYMENTS - canonical source: MEA-1043/);
  assert.match(rendered, /VERIFICATION NOTE: This seed path rejects the May 25, 2026 failure mode/);
});

test("extracts the deployment section from the canonical routine report", () => {
  const section = extractDeploymentSection([
    "Engineering standup for May 25, 2026",
    "",
    "**DEPLOYMENTS**",
    "",
    "**PRODUCTION**",
    "- No production deployment record landed.",
    "",
    "**LIVE PREVIEWS**",
    "- Preview still live.",
    "",
    "**SHIPPED**",
    "- Nothing shipped.",
  ].join("\n"));

  assert.equal(section, [
    "**DEPLOYMENTS**",
    "",
    "**PRODUCTION**",
    "- No production deployment record landed.",
    "",
    "**LIVE PREVIEWS**",
    "- Preview still live.",
  ].join("\n"));
});

test("extracts Slack-style deployment heading before issue categories", () => {
  const section = extractDeploymentSection([
    "*CEO Standup — May 28, 2026*",
    "",
    "📦 *Deployments*",
    "*Production*",
    "No production deployment records landed.",
    "",
    "*Live Previews*",
    "- Preview is live.",
    "",
    "👀 *In Staging — 25 Issues*",
    "- MEA-1007 is ready for review.",
  ].join("\n"));

  assert.equal(section, [
    "📦 *Deployments*",
    "*Production*",
    "No production deployment records landed.",
    "",
    "*Live Previews*",
    "- Preview is live.",
  ].join("\n"));
});

test("selects the latest deployment-bearing comment before housekeeping comments", () => {
  const selected = latestDeploymentSectionFromComments([
    { id: "old", body: "**DEPLOYMENTS**\n\n**PRODUCTION**\n- Older deployment note." },
    { id: "latest", body: "**DEPLOYMENTS**\n\n**PRODUCTION**\n- Current deployment note." },
    { id: "closeout", body: "Closing this heartbeat; the report above is final." },
  ]);

  assert.equal(selected.commentId, "latest");
  assert.equal(selected.section, "**DEPLOYMENTS**\n\n**PRODUCTION**\n- Current deployment note.");
});
