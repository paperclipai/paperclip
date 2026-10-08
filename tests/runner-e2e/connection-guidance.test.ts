import { describe, expect, it } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { everydayTasks } from "./everyday-cases.js";
import { CONNECTION_GUIDANCE_SUITE, connectionGuidanceTasks, connectionGuidanceDefinitionDigest } from "./connection-guidance-cases.js";
import { gradeConnectionGuidanceDecline } from "./connection-guidance-evidence.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

describe("neutral connection guidance selection", () => {
  it("requires explicit selection and admits five stories on exactly three local native profiles", () => {
    const selected = selectRunnerExecutions(parseRunnerSelectors(["--suite", CONNECTION_GUIDANCE_SUITE]));
    expect(selected).toHaveLength(15);
    expect(new Set(selected.map(row => row.profile.id))).toEqual(new Set(["runner-codex", "runner-acpx-claude", "runner-opencode"]));
    for (const row of selected) {
      expect(row.environment.id).toBe("local");
      expect(row.task.automaticRetryPolicy).toBe("single_attempt");
      expect(row.task.attemptTimeoutMs.local).toBe(720_000);
      expect(row.task.expectedRunCount).toBe(row.task.id === "provider-second" ? 3 : 2);
    }
    for (const args of [["--all"], ["--profile", "runner-opencode"]]) {
      expect(selectRunnerExecutions(parseRunnerSelectors(args), runnerMatrix).some(row => row.suite.id === CONNECTION_GUIDANCE_SUITE)).toBe(false);
    }
    expect(runnerSuites.find(suite => suite.id === CONNECTION_GUIDANCE_SUITE)?.definitionMetadata)
      .toMatchObject({ fixtureDigest: connectionGuidanceDefinitionDigest(), companyAndAgentBudgetCents: 1_000, maximumAttemptsPerCell: 1 });
  });
  it("keeps workflow instructions out of new decline prompts and preserves the historical prompts", () => {
    for (const task of connectionGuidanceTasks) {
      const original = everydayTasks.find(row => row.id === task.id)!;
      if (task.id.endsWith("decline")) {
        expect(task.buildPrompt("nonce")).toMatch(/brief explanation is enough/);
        expect(task.buildPrompt("nonce")).not.toMatch(/declin|Not now|None for now|do not|retry|try again|connection_request|connections_search|paperclip_|yield|poll/i);
        expect(task.buildPrompt("nonce")).not.toBe(original.buildPrompt("nonce"));
      } else expect(task.buildPrompt("nonce")).toBe(original.buildPrompt("nonce"));
    }
    expect(everydayTasks.find(task => task.id === "service-decline")!.buildPrompt("nonce")).toContain("do not try again");
    expect(everydayTasks.find(task => task.id === "connection-decline")!.buildPrompt("nonce")).toContain("do not try again");
  });
});

const valid = {
  caseId: "provider-decline" as const, decisionId: "decision", leadAgentId: "lead", issueId: "task",
  decisions: [{ id: "decision", kind: "ask_user_questions", status: "answered", resolvedAt: "2026-10-06T22:00:00Z",
    result: { answers: [{ questionId: "connection-provider:hubspot", optionIds: ["none"] }] } }],
  replies: [{ authorAgentId: "lead", createdByRunId: "run", createdAt: "2026-10-06T22:00:02Z", body: "Contacts are unavailable after your decision." }],
  runs: [{ id: "run", nativeIssueId: "task", agentId: "lead", status: "succeeded", finishedAt: "2026-10-06T22:00:03Z" }],
  calls: 0, marker: "PRIVATE_MARKER", sameConnections: true,
};
const passes = (input: Parameters<typeof gradeConnectionGuidanceDecline>[0]) =>
  gradeConnectionGuidanceDecline(input).every(check => check.passed);

describe("neutral decline evidence", () => {
  it("accepts an attributed explanation after each kind of saved decline", () => {
    expect(passes(valid)).toBe(true);
    for (const [caseId, kind] of [["service-decline", "request_confirmation"], ["connection-decline", "connection_intent"]] as const) {
      expect(passes({ ...valid, caseId, decisions: [{ ...valid.decisions[0], kind, status: "rejected" }] })).toBe(true);
    }
  });
  it("recognizes unavailable-connection contractions without accepting positive or unrelated claims", () => {
    for (const body of [
      "HubSpot isn't connected because you chose None for now.",
      "HubSpot isn’t connected after the provider decision.",
      "The pages aren't retrievable after the connection decision.",
    ]) expect(passes({ ...valid, replies: [{ ...valid.replies[0], body }] })).toBe(true);
    for (const body of ["HubSpot is connected.", "HubSpot isn't disconnected.", "HubSpot isn't slow.", "Contacts are available."]) {
      expect(passes({ ...valid, replies: [{ ...valid.replies[0], body }] })).toBe(false);
    }
  });
  it("rejects missing, stale, unattributed, wrong-agent, or unsuccessful explanations", () => {
    for (const input of [
      { ...valid, replies: [] },
      { ...valid, replies: [{ ...valid.replies[0], body: "Done." }] },
      { ...valid, replies: [{ ...valid.replies[0], body: { text: "Unavailable" } }] },
      { ...valid, replies: [{ ...valid.replies[0], createdAt: "2026-10-06T21:59:00Z" }] },
      { ...valid, replies: [{ ...valid.replies[0], createdByRunId: undefined }] },
      { ...valid, replies: [{ ...valid.replies[0], createdByRunId: null, runId: "run" }] },
      { ...valid, replies: [{ ...valid.replies[0], createdByRunId: "other-run" }] },
      { ...valid, replies: [{ ...valid.replies[0], authorAgentId: "worker" }] },
      { ...valid, replies: [{ ...valid.replies[0], createdAt: "invalid" }] },
      { ...valid, runs: [{ ...valid.runs[0], agentId: "worker" }] },
      { ...valid, runs: [{ ...valid.runs[0], nativeIssueId: "other-task" }] },
      { ...valid, runs: [{ ...valid.runs[0], nativeIssueId: undefined }] },
      { ...valid, runs: [{ ...valid.runs[0], status: "failed" }] },
      { ...valid, runs: [{ ...valid.runs[0], finishedAt: "2026-10-06T21:59:00Z" }] },
    ]) expect(passes(input)).toBe(false);
  });
  it("rejects wrong or repeated decisions, early use, missing call evidence and connection changes", () => {
    for (const input of [
      { ...valid, decisionId: "other" },
      { ...valid, decisions: [] },
      { ...valid, decisions: [...valid.decisions, ...valid.decisions] },
      { ...valid, decisions: [{ ...valid.decisions[0], resolvedAt: undefined }] },
      { ...valid, decisions: [{ ...valid.decisions[0], kind: "request_confirmation" }] },
      { ...valid, decisions: [{ ...valid.decisions[0], status: "pending" }] },
      { ...valid, decisions: [{ ...valid.decisions[0], result: { answers: [{ questionId: "connection-provider:hubspot", optionIds: ["via:arcade:hubspot"] }] } }] },
      { ...valid, calls: 1 },
      { ...valid, calls: undefined },
      { ...valid, sameConnections: false },
      { ...valid, replies: [{ ...valid.replies[0], body: "Unavailable, but PRIVATE_MARKER" }] },
    ]) expect(passes(input)).toBe(false);
  });
});


import { requireProviderAccessCard, gradeProviderOutcome } from "./connection-routing-evidence.js";
const access = { id: "access", kind: "connection_intent", status: "pending", payload: {
  serviceSlug: "arcade", requestingAgentId: "lead", upstreamService: { slug: "hubspot", selectionInteractionId: "choice" },
  accessRequest: { connectionId: "connection", tools: [{ catalogEntryId: "tool", toolName: "Hubspot_ListContacts", permission: "allowed" }] },
} };
const accessInput = { rows: [{ id: "choice", kind: "ask_user_questions", status: "answered" }, access],
  decisionId: "choice", connectionId: "connection", agentId: "lead", catalogEntryIds: ["tool"], calls: 0 };
it("requires the exact scoped access card and rejects early calls, swapped identities and duplicates", () => {
  expect(requireProviderAccessCard(accessInput)).toBe(access);
  for (const input of [
    { ...accessInput, rows: [] }, { ...accessInput, calls: 1 }, { ...accessInput, catalogEntryIds: [] },
    { ...accessInput, connectionId: "other" }, { ...accessInput, agentId: "other" }, { ...accessInput, decisionId: "other" },
    { ...accessInput, rows: [...accessInput.rows, access] },
    { ...accessInput, rows: [accessInput.rows[0], { ...access, status: "accepted" }] },
    { ...accessInput, rows: [accessInput.rows[0], { ...access, payload: { ...access.payload, upstreamService: { slug: "hubspot", selectionInteractionId: "other" } } }] },
  ]) expect(() => requireProviderAccessCard(input)).toThrow();
});
it("requires the real accepted access result without allowing repeated provider questions", () => {
  const choice = { id: "choice", kind: "ask_user_questions", status: "answered", result: { answers: [{ questionId: "connection-provider:hubspot", optionIds: ["via:arcade:hubspot"] }] } };
  const granted = { ...access, status: "accepted", result: { outcome: "connected", connectionId: "connection" } };
  const input = { rows: [choice, granted], decisionId: "choice", selected: "via:arcade:hubspot", calls: 1,
    response: "Ada Fixture MARKER", marker: "MARKER", sameConnections: true, accessDecision: { id: "access", connectionId: "connection" } };
  expect(gradeProviderOutcome(input).every(c => c.passed)).toBe(true);
  for (const bad of [{ ...input, rows: [choice] }, { ...input, rows: [choice, granted, choice] },
    { ...input, rows: [choice, { ...granted, status: "pending" }] }, { ...input, accessDecision: { id: "access", connectionId: "other" } },
    { ...input, calls: 0 }, { ...input, calls: 2 }, { ...input, response: "Done" }])
    expect(gradeProviderOutcome(bad).every(c => c.passed)).toBe(false);
});
