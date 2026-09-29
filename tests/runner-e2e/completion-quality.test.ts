import { describe, expect, it } from "vitest";
import { COMPLETION_QUALITY_CONFIG, completionQualityControls, completionQualityStatus, completionQualityRequest, judgeCompletionQuality, reserveCompletionQuality, validateCompletionQuality } from "./completion-quality.js";
const observation = { sourceId: "chat", marker: "REF", worker: { id: "task", title: "Welcome", status: "done", completedAt: "2026-09-01T00:00:00Z" }, documents: [{ id: "doc", issueId: "task", key: "welcome", body: "Welcome to the garden. Meet at 10:30." }], comments: [{ id: "reply", issueId: "chat", authorAgentId: "agent", createdAt: "2026-09-01T00:01:00Z", body: "The note is ready at /issues/task", createdByRunId: "run" }], runs: [] };
const criteria = Object.keys(COMPLETION_QUALITY_CONFIG.rubric).map(id => ({ id, passed: true, rationale: "Supported by the saved note and reply", evidenceIds: ["reply", "doc"] }));
const reports = [{ replyId: "reply", rationale: "Reports the completed task", completedTaskIdsReferenced: ["task"], resultAccessTaskIds: ["task"], correctsReplyIds: [] as string[] }];
describe("completion semantic qualification", () => {
  it("uses a pinned no-tool judge and separates untrusted evidence from instructions", () => {
    const request = completionQualityRequest(observation);
    expect(request.model).toBe(COMPLETION_QUALITY_CONFIG.model); expect(request).not.toHaveProperty("tools");
    expect(request.instructions).toContain("untrusted evidence"); expect(request.input).toContain("10:30");
    expect(request.text.format.schema.properties.criteria.items.properties.evidenceIds.items.enum)
      .toEqual(["task", "doc", "reply"]);
  });
  it("includes only observed, same-reply links to known task results", () => {
    const o = { ...observation, worker: { ...observation.worker, identifier: "GARDEN-2" }, renderedLinks: [
      { commentId: "reply", href: "/GARDEN/issues/GARDEN-2?private-query=ignored" },
      { commentId: "reply", href: "/GARDEN/issues/GARDEN-2" },
      { commentId: "other-reply", href: "/issues/task" },
      { commentId: "reply", href: "/issues/foreign" },
      { commentId: "reply", href: "https://external.invalid/issues/task" },
      { commentId: "reply", href: "//external.invalid/issues/task" },
      { commentId: "reply", href: "/%invalid/issues/task" },
    ] };
    const evidence = JSON.parse(completionQualityRequest(o).input);
    expect(evidence.replies[0].renderedResultLinks).toEqual([{ taskId: "task", href: "/GARDEN/issues/GARDEN-2" }]);
    expect(JSON.parse(completionQualityRequest(observation).input).replies[0].renderedResultLinks).toEqual([]);
  });
  it("preserves a failure even when the other criteria pass", () => {
    expect(validateCompletionQuality({ criteria, reports }, observation).passed).toBe(true);
    expect(validateCompletionQuality({ reports, criteria: criteria.map((c, i) => ({ ...c, passed: i !== 0 })) }, observation).passed).toBe(false);
  });
  it("separates product failures from a missing or miscalibrated judge", () => {
    const product = { ...reserveCompletionQuality(observation, 1), status: "completed" as const,
      name: "completion-update.json", purpose: "product" as const, expectedPass: true, passed: true };
    const negativeControl = { ...product, name: "stale", purpose: "calibration" as const, expectedPass: false, passed: false };
    expect(completionQualityStatus([product, negativeControl])).toBe("passed");
    expect(completionQualityStatus([{ ...product, passed: false }, negativeControl])).toBe("failed");
    expect(completionQualityStatus([product, { ...negativeControl, passed: true }])).toBe("unqualified");
    expect(completionQualityStatus([{ ...product, status: "failed" }])).toBe("unqualified");
    expect(completionQualityStatus([])).toBe("unqualified");
  });
  const twoReplies = { ...observation, worker: { ...observation.worker, companyId: "fixture" },
    relatedTasks: [{ task: { id: "second", companyId: "fixture", status: "done", completedAt: observation.worker.completedAt },
      documents: [{ id: "second-doc", issueId: "second", key: "result", body: "Second result" }] }],
    comments: [...observation.comments, { ...observation.comments[0], id: "reply-again", createdAt: "2026-09-01T00:02:00Z" }],
  };
  it.each([
    [["task"], ["task"], [], false],
    [["task"], ["task", "second"], [], true],
    [["task", "second"], ["task"], [], false],
    [[], ["task"], [], true],
    [["task"], ["task"], ["reply"], true],
    [["task"], ["second"], [], true],
    [["task"], [], [], true],
  ])("evaluates newly reported results and corrections (%j → %j)", (first, second, corrections, passed) => {
    const inventory = [
      { ...reports[0], completedTaskIdsReferenced: first as string[], resultAccessTaskIds: first as string[] },
      { ...reports[0], replyId: "reply-again", completedTaskIdsReferenced: second as string[], resultAccessTaskIds: second as string[], correctsReplyIds: corrections as string[] },
    ];
    const verdict = validateCompletionQuality({ criteria, reports: inventory }, twoReplies);
    expect(verdict.passed).toBe(passed);
    expect(verdict.reports).toEqual(inventory);
    if (!passed) expect(verdict.criteria.at(-1)?.evidenceIds).toEqual(["reply", "reply-again"]);
  });
  it("accepts first result access after a status-only announcement, but rejects a third redundant reply", () => {
    const inventory = [{ ...reports[0], resultAccessTaskIds: [] }, { ...reports[0], replyId: "reply-again" }];
    expect(validateCompletionQuality({ criteria, reports: inventory }, twoReplies).passed).toBe(true);
    const repeated = { ...twoReplies, comments: [...twoReplies.comments,
      { ...observation.comments[0], id: "third", createdAt: "2026-09-01T00:03:00Z" }] };
    expect(validateCompletionQuality({ criteria, reports: [...inventory, { ...reports[0], replyId: "third" }] }, repeated).passed).toBe(false);
  });
  it("requires result access to reference unique, inventoried tasks", () => {
    for (const access of [undefined, ["foreign"], ["second"], ["task", "task"]]) {
      expect(() => validateCompletionQuality({ criteria, reports: [{ ...reports[0], resultAccessTaskIds: access }] }, observation)).toThrow(/inventory/);
    }
  });
  it("uses recorded chronology instead of model report order", () => {
    const inventory = [{ ...reports[0], replyId: "reply-again", completedTaskIdsReferenced: ["task", "second"] }, reports[0]];
    expect(validateCompletionQuality({ criteria, reports: inventory }, { ...twoReplies, comments: [...twoReplies.comments].reverse() }).passed).toBe(true);
  });
  it("rejects omitted, duplicate, foreign, and forward-looking report references", () => {
    for (const inventory of [
      reports, [reports[0], reports[0]],
      [reports[0], { ...reports[0], replyId: "foreign" }],
      [reports[0], { ...reports[0], replyId: "reply-again", completedTaskIdsReferenced: ["foreign-task"] }],
      [reports[0], { ...reports[0], replyId: "reply-again", completedTaskIdsReferenced: ["task", "task"] }],
      [{ ...reports[0], correctsReplyIds: ["reply-again"] }, { ...reports[0], replyId: "reply-again" }],
      [reports[0], { ...reports[0], replyId: "reply-again", correctsReplyIds: ["reply-again"] }],
      [reports[0], { ...reports[0], replyId: "reply-again", correctsReplyIds: ["foreign"] }],
    ]) expect(() => validateCompletionQuality({ criteria, reports: inventory }, twoReplies)).toThrow(/inventory/);
  });
  it("grounds a joint reply in the other delegated task's result without including foreign or plan documents", () => {
    const input = { ...observation, worker: { ...observation.worker, companyId: "fixture" }, relatedTasks: [
      { task: { id: "second", companyId: "fixture", status: "done", completedAt: observation.worker.completedAt, title: "PRIVATE TITLE" },
        documents: [{ id: "second-doc", issueId: "second", key: "welcome", body: "Another saved welcome note. Contact alice@example.com." },
          { id: "plan", issueId: "second", key: "plan", body: "PRIVATE PLAN" },
          { id: "foreign-doc", issueId: "elsewhere", key: "welcome", body: "PRIVATE OTHER TASK" }] },
      { task: { id: "foreign", companyId: "other", status: "done", completedAt: observation.worker.completedAt },
        documents: [{ id: "foreign-doc", issueId: "foreign", key: "welcome", body: "PRIVATE COMPANY" }] },
    ] };
    const evidence = JSON.parse(completionQualityRequest(input).input);
    expect(evidence.relatedTasks).toHaveLength(1);
    expect(evidence.relatedTasks[0].documents).toEqual([{ id: "second-doc", body: "Another saved welcome note. Contact [REDACTED_EMAIL]." }]);
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
    expect(validateCompletionQuality({ reports, criteria: criteria.map(c => ({ ...c, evidenceIds: ["reply", "second-doc"] })) }, input).passed).toBe(true);
  });
  it("rejects invented references, missing evidence, duplicate criteria and missing replies", () => {
    expect(() => validateCompletionQuality({ reports, criteria: criteria.map(c => ({ ...c, evidenceIds: ["invented"] })) }, observation)).toThrow();
    expect(() => validateCompletionQuality({ reports, criteria: criteria.map(c => ({ ...c, evidenceIds: ["doc"] })) }, observation)).toThrow();
    expect(() => validateCompletionQuality({ reports, criteria: criteria.map((c, i) => i === 1 ? criteria[0] : c) }, observation)).toThrow();
    expect(() => completionQualityRequest({ ...observation, comments: [] })).toThrow();
    expect(() => reserveCompletionQuality(observation, 0.000001)).toThrow();
  });
  it("calibrates repeated announcements without rejecting corrections or distinct-task updates", () => {
    const controls = completionQualityControls(observation);
    expect(controls.map(c => [c.name, c.expectedPass])).toEqual([["accurate", true], ["stale", false], ["unsupported", false], ["corrected", true],
      ["duplicate", false], ["redundant-acknowledgement", false], ["distinct-tasks", true],
      ["pending-then-joint", true], ["joint-then-repeated", false], ["supported-content-check", true], ["unsupported-content-check", false], ["rendered-task-link", true], ["unlinked-status-only", false], ["completion-then-result", true], ["completion-then-result-then-repeat", false], ["recap-with-new-result", true]]);
    expect(controls[3].observation.comments).toHaveLength(2);
    expect(controls[4].observation.comments[0].body).not.toBe(controls[4].observation.comments[1].body);
    const distinct = JSON.parse(completionQualityRequest(controls[6].observation).input);
    expect(distinct.relatedTasks).toHaveLength(1);
    expect(distinct.replies[1].body).toContain(distinct.relatedTasks[0].task.id);
    expect(observation.comments).toHaveLength(1);
    for (const c of controls) expect(completionQualityRequest(c.observation).input).toContain("10:30");
  });
  it("requires approval and sends only minimized, redacted fixture evidence", async () => {
    const privateObservation = { ...observation, fixtureRequest: "Save a garden note. Contact alice@example.com. Key private-fixture-value.", worker: { ...observation.worker, title: "PRIVATE TITLE" },
      documents: [...observation.documents.map(d => ({ ...d, body: d.body + " Key private-fixture-value contact alice@example.com or 212-555-0199" })),
        { id: "unrelated", issueId: "other", key: "note", body: "PRIVATE OTHER TASK" }, { id: "plan", issueId: "task", key: "plan", body: "PRIVATE PLAN" }],
      comments: [...observation.comments, { ...observation.comments[0], id: "other", issueId: "other", body: "PRIVATE OTHER CHAT" }] };
    const secrets = ["private-fixture-value"];
    const pending = reserveCompletionQuality(privateObservation, 0.5, secrets);
    let calls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      calls++;
      const request = String(init?.body);
      expect(request).not.toMatch(/private-fixture-value|alice@example.com|212-555-0199|PRIVATE/);
      expect(request).toContain("REDACTED");
      expect(JSON.parse(JSON.parse(request).input).fixtureRequest).toContain("Save a garden note.");
      return new Response(JSON.stringify({ status: "completed", model: COMPLETION_QUALITY_CONFIG.model, usage: { input_tokens: 100, output_tokens: 50 }, output: [{ content: [{ type: "output_text", text: JSON.stringify({ criteria, reports }) }] }] }));
    };
    expect((await judgeCompletionQuality(privateObservation, pending, "fixture-key", fetcher)).status).toBe("failed");
    expect(calls).toBe(0);
    expect((await judgeCompletionQuality(privateObservation, pending, "fixture-key", fetcher, { approvedFixture: true, secrets })).status).toBe("completed");
    expect(calls).toBe(1);
  });
  it("fails closed on missing usage and does not retry", async () => {
    let calls = 0;
    const result = await judgeCompletionQuality(observation, reserveCompletionQuality(observation, 1), "fixture-key", async () => {
      calls++; return new Response(JSON.stringify({ status: "completed", model: COMPLETION_QUALITY_CONFIG.model }));
    }, { approvedFixture: true, secrets: [] });
    expect(result.status).toBe("failed"); expect(result.passed).toBe(false); expect(calls).toBe(1);
  });
  it("retains a redacted invalid verdict for diagnosis without accepting its references", async () => {
    const result = await judgeCompletionQuality(observation, reserveCompletionQuality(observation, 1), "fixture-key", async () =>
      new Response(JSON.stringify({ status: "completed", model: COMPLETION_QUALITY_CONFIG.model,
        usage: { input_tokens: 100, output_tokens: 50 }, output: [{ content: [{ type: "output_text", text: JSON.stringify({
          reports, criteria: criteria.map(c => ({ ...c, evidenceIds: ["invented"], rationale: "private-fixture-value alice@example.com" })),
        }) }] }] })), { approvedFixture: true, secrets: ["private-fixture-value"] });
    expect(result.status).toBe("failed"); expect(result.passed).toBe(false);
    expect(result).toHaveProperty("rejectedVerdict", expect.stringContaining("invented"));
    expect(JSON.stringify(result)).not.toMatch(/private-fixture-value|alice@example.com/);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });
});
