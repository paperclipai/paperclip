import { describe, expect, it } from "vitest";
import { renderCaseOutcome } from "./case-outcome.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import {
  firstTaskTranscript,
  renderFirstTaskTranscript,
} from "./first-task-transcript.js";
import type {
  FirstTaskEvidence,
  FirstTaskCheckpoint,
} from "./first-task-scoring.js";
import type { RunnerE2EResult } from "./types.js";

function recording(): FirstTaskEvidence {
  const opening: FirstTaskCheckpoint = {
    id: "opening",
    phase: "opening",
    at: "2026-09-15T00:00:00Z",
    issueId: "task",
    tasks: [],
    agents: [{ id: "agent", name: "Alex" }],
    runs: [],
    documents: [],
    comments: [{ id: "greeting", authorAgentId: "agent", body: "Welcome" }],
    interactions: [
      {
        id: "question",
        kind: "ask_user_questions",
        status: "pending",
        payload: {
          questions: [
            {
              id: "q",
              prompt: "What would help?",
              options: [{ id: "plan", label: "Make a plan" }],
            },
          ],
        },
      },
    ],
  };
  const response = structuredClone(opening);
  Object.assign(response, {
    id: "response",
    phase: "response",
    at: "2026-09-15T00:01:00Z",
  });
  Object.assign(response.interactions[0], {
    status: "answered",
    resolvedAt: "2026-09-15T00:00:20Z",
    result: {
      answers: [
        {
          questionId: "q",
          optionIds: ["plan"],
          otherText: "Use our garden club facts",
        },
      ],
    },
  });
  response.comments.push({
    id: "reply",
    authorAgentId: "agent",
    body: "Shall I proceed? <script>unsafe()</script>",
    createdAt: "2026-09-15T00:00:50Z",
  });
  response.documents.push({
    id: "doc",
    key: "plan",
    title: "Proposal",
    body: "Original scope",
    latestRevisionId: "v1",
    latestRevisionNumber: 1,
  });
  const finished = structuredClone(response);
  Object.assign(finished, {
    id: "finished",
    phase: "finished",
    at: "2026-09-15T00:02:00Z",
  });
  Object.assign(finished.documents[0], {
    body: "Revised scope",
    latestRevisionId: "v2",
    latestRevisionNumber: 2,
  });
  return {
    caseId: "clear-task-first-response",
    nonce: "test",
    onboardingIssueId: "task",
    agentId: "agent",
    initialTaskIds: ["task"],
    instructions: [],
    configuredModel: null,
    observedModels: [],
    checkpoints: [opening, response, finished],
    checks: [
      {
        id: "no-premature-work",
        passed: true,
        detail: "No work before approval",
        evidence: ["response"],
      },
    ],
  };
}
function result(): RunnerE2EResult {
  return {
    schema: "paperclip.runner-e2e.result/v2",
    suiteId: "first-task",
    executionId: "first-task.legacy-codex.local.clear-task-first-response",
    attempt: 1,
    status: "failed",
    profileId: "legacy-codex",
    environmentId: "local",
    caseId: "clear-task-first-response",
    provider: "openai",
    model: "unknown",
    runtimeMode: "legacy",
    startedAt: "2026-09-15T00:00:00Z",
    finishedAt: "2026-09-15T00:02:00Z",
    durationMs: 120000,
    runIds: [],
    cleanup: "passed",
    firstTask: recording(),
    failureClass: "secret_leak",
    error:
      "Credential detected in persisted Paperclip home: sessions/example.json",
  };
}

describe("first-task conversation report", () => {
  it("deduplicates observations, keeps first-observed time, and includes answers and each document revision", () => {
    const entries = firstTaskTranscript(recording());
    expect(entries.filter((e) => e.kind === "comment")).toHaveLength(2);
    expect(entries.filter((e) => e.kind === "interaction")).toHaveLength(1);
    expect(entries.filter((e) => e.kind === "answer")).toHaveLength(1);
    expect(
      entries.filter((e) => e.kind === "document").map((e) => e.row.body),
    ).toEqual(["Original scope", "Revised scope"]);
    expect(entries.find((e) => e.row.id === "greeting")?.at).toBe(
      "2026-09-15T00:00:00Z",
    );
    expect(entries.find((e) => e.kind === "interaction")?.row.status).toBe(
      "answered",
    );
    expect(entries.findIndex((e) => e.kind === "answer")).toBeLessThan(
      entries.findIndex((e) => e.row.id === "reply"),
    );
  });
  it("renders full text, option labels, source references, and escaped untrusted chat", () => {
    const e = recording();
    const longText = "Full retained body ".repeat(1000);
    e.checkpoints.at(-1)!.comments.push({ id: "long", body: longText });
    const rendered = renderFirstTaskTranscript(e, (id) => `#${id}`);
    expect(rendered).toContain(longText);
    expect(rendered).toContain("Agent · Alex");
    expect(rendered).toContain("transcript-comment transcript-agent");
    expect(rendered).toContain("transcript-comment transcript-human");
    expect(rendered).toContain("transcript-answer transcript-human");
    expect(rendered).toContain("transcript-interaction transcript-card");
    expect(rendered).toContain("User card response");
    expect(rendered).toContain("Make a plan\nUse our garden club facts");
    expect(rendered).toContain('href="#finished"');
    expect(rendered).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(rendered).not.toContain("<script>");
  });
  it("makes the non-matcher failure explicit when all behavior checks pass", () => {
    const rendered = renderCaseOutcome(result(), false, [result().error!]);
    expect(rendered).toContain("Overall failed · 1/1 behavioral checks passed");
    expect(rendered).toContain("No behavioral matcher failed");
    expect(rendered).toContain("Credential-persistence check failed");
    expect(rendered.match(/sessions\/example.json/g)).toHaveLength(1);
  });
  it("names failed matchers and retains independent validation failures", () => {
    const r = result();
    r.firstTask!.checks[0] = {
      id: "no-premature-work",
      passed: false,
      detail: "Created <final> document before acceptance",
      evidence: ["response"],
    };
    const rendered = renderCaseOutcome(r, false, ["Evidence missing"]);
    expect(rendered).toContain("0/1 behavioral checks passed");
    expect(rendered).toContain("<strong>no-premature-work</strong>");
    expect(rendered).toContain(
      "Created &lt;final&gt; document before acceptance",
    );
    expect(rendered).toContain("Evidence missing");
    expect(rendered).not.toContain("No behavioral matcher failed");
  });
  it("separates unexercised checks from behavioral failures and passes", () => {
    const r = result();
    r.firstTask!.checks.push({
      id: "rejection-respected", passed: false, evidence: [],
      detail: "Rejected work never executes",
      notReached: "The rejection checkpoint was not reached <yet>.",
    });
    const rendered = renderCaseOutcome(r, false, []);
    expect(rendered).toContain("1/1 behavioral checks passed · 1 not reached");
    expect(rendered).toContain("Not reached:");
    expect(rendered).toContain("The journey is incomplete");
    expect(rendered).toContain("not reached &lt;yet&gt;");
    expect(rendered).not.toContain("<p>Failed checks:</p>");
    expect(rendered).not.toContain("separate run, cleanup, or evidence check");
    expect(rendered).toContain("<td>Not reached</td>");
    expect(rendered).toContain("Overall failed");
  });

  it("does not invent matcher results when a run fails before assertions", () => {
    const r = result();
    r.firstTask = undefined;
    expect(renderCaseOutcome(r, false, [])).toContain(
      "No behavioral checks recorded",
    );
    r.status = "passed";
    r.failureClass = undefined;
    r.error = undefined;
    expect(renderCaseOutcome(r, true, [])).toContain("Overall passed");
  });
  it("keeps large timeout payloads expandable without burying the checks and conversation", () => {
    const r = result();
    r.error = `Timed out waiting for outcome: ${"recorded state ".repeat(200)}<unsafe>`;
    const rendered = renderCaseOutcome(r, false, []);
    expect(rendered).toContain("<details><summary>Full failure details");
    expect(rendered).toContain("&lt;unsafe&gt;");
    expect(rendered).not.toContain("<unsafe>");
    expect(rendered).toContain("Overall failed");
  });
  it("shows an interrupted regraded journey consistently in the dashboard and gallery", () => {
    const r = result();
    r.failureClass = "candidate_failure";
    r.error = "Recording stopped before acceptance.";
    r.firstTask!.checks.push({
      id: "acceptance-recorded", passed: false, evidence: [],
      detail: "Acceptance recorded", notReached: "No acceptance checkpoint.",
    });
    r.matcherResults = [{ matcher: { kind: "json_path", path: "old-check", expected: true }, passed: false, detail: "Stale result" }];
    r.screenshots = [{ id: "failure", label: "Task state at failure", file: "failure.png", publication: "public-runner-fixture" }];
    const render = (errors: string[] = []) => renderRunnerE2EDashboard({
      title: "Regraded campaign", generatedAt: r.finishedAt,
      expected: [r.executionId], catalog: [],
      entries: [{ result: r, valid: false, errors, evidenceBaseHref: "evidence/codex", evidenceFiles: ["failure.png", "result.json", "regraded-result.json"] }],
    });
    const page = render();
    expect(page).toContain('data-gallery-status="incomplete"');
    expect(page).toContain('data-gallery-matchers="1/1 matchers passed · 1 not reached"');
    expect(page).toContain('data-gallery-label="Task state when recording stopped"');
    expect(page).toContain("Incomplete journey");
    expect(page).toContain('<strong>1</strong><span>Incomplete</span>');
    expect(page).toContain('<strong>0</strong><span>Failed</span>');
    expect(page).toContain("Regraded result JSON");
    expect(page).toContain("Original result JSON");
    expect(page).not.toContain("<td>Stale result</td>");
    expect(render(["Evidence missing"])).toContain('data-gallery-status="failed"');
  });

  it("integrates visible outcome, transcript, and only available evidence links in the dashboard", () => {
    const r = result();
    const rendered = renderRunnerE2EDashboard({
      title: "Smoke review",
      generatedAt: r.finishedAt,
      expected: [r.executionId],
      catalog: [],
      entries: [
        {
          result: r,
          valid: false,
          errors: [],
          evidenceBaseHref: "evidence/codex",
          evidenceFiles: [
            "snapshots/first-task.json",
            "snapshots/first-task-run-evidence.json",
            "result.json",
          ],
        },
      ],
    });
    expect(rendered).toContain("Read full conversation</summary>");
    expect(rendered).toContain(
      'href="evidence/codex/snapshots/first-task-run-evidence.json"',
    );
    expect(rendered).not.toContain(
      'href="evidence/codex/html-report/index.html"',
    );
    expect(rendered.indexOf("Full run / tool-event JSON")).toBeLessThan(
      rendered.indexOf("Matchers and test context</summary>"),
    );
    expect(rendered).toContain(
      'id="first-task-first-task.legacy-codex.local.clear-task-first-response-response"',
    );
  });
});
