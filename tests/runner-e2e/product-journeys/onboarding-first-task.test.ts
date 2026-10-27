import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionProof } from "../connection-evidence.js";
import { connectionDelay } from "../connection-target.js";
import { onboardingFirstTask, type OnboardingFirstTaskInput } from "./onboarding-first-task.js";
import { validateOnboardingArtifact } from "./artifact-evidence.js";
import { validateOnboardingPreAcceptanceEvidence } from "./onboarding-pre-acceptance.js";

vi.mock("../connection-target.js", () => ({ connectionDelay: vi.fn(async () => {}) }));
type Row = { id: string; [key: string]: any };
type Options = {
  plan?: boolean;
  wrongProof?: boolean;
  readbackFailure?: "reload" | "download-link";
  mutate?(phase: string, state: { tasks: Row[]; runs: Row[]; interactions: Row[]; documents: Row[]; attachments: Row[]; comments: Row[] }): void;
};

/** Models the existing REST responses and visible card controls, with no mutating API. */
function fixture(options: Options = {}) {
  let phase = "opening";
  const proof = createConnectionProof();
  const bytes = Buffer.from(JSON.stringify(options.wrongProof ? { ...proof.expected, total: proof.expected.total + 1 } : proof.expected));
  const events: string[] = [];
  const title = "Artifact campaign-1";
  const run = (id: string, issueId: string): Row => ({
    id, companyId: "company", agentId: "agent", nativeIssueId: issueId, runtimeMode: "native", status: "succeeded",
    startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", usageJson: { inputTokens: 1, outputTokens: 1 },
    contextSnapshot: { issueId, aiConnection: { connectionId: "connection", method: "api_key" }, paperclipEnvironment: { id: "environment" } },
  });
  const state = () => {
    const accepted = phase === "accepted";
    const parent = { id: "parent", identifier: "QA-1", title: "Paperclip onboarding", originKind: "onboarding_first_task", description: "/first-task", assigneeAgentId: "agent", status: accepted ? "done" : "in_review" };
    const opening = { id: "opening", kind: "ask_user_questions", status: phase === "opening" ? "pending" : "answered", payload: { submitLabel: "Continue", questions: [{ id: "first-task-opening", options: [{ id: "task", label: "I have a task in mind", freeText: true }] }] } };
    const proposal = { id: "proposal", kind: options.plan ? "request_checkbox_confirmation" : "request_confirmation", status: accepted ? "accepted" : "pending", payload: { prompt: `Create one child task: ${title}`, ...(options.plan ? { options: [{ id: "scope", label: "One artifact task" }], target: { type: "issue_document", key: "plan", revisionId: "revision" } } : {}) } };
    const result = {
      tasks: [parent, ...(accepted ? [{ id: "child", identifier: "QA-2", title, parentId: "parent", assigneeAgentId: "agent", status: "done" }] : [])],
      runs: phase === "opening" ? [] : [run("proposal-run", "parent"), ...(accepted ? [run("acceptance-run", "parent"), run("child-run", "child"), run("completion-run", "parent")] : [])],
      interactions: [opening, ...(phase === "opening" ? [] : [proposal])],
      documents: [...(options.plan && phase !== "opening" ? [{ id: "plan", issueId: "parent", key: "plan", latestRevisionId: "revision", body: `One child: ${title}` }] : []), ...(accepted ? [{ id: "result", issueId: "child", key: "connection-proof", updatedByAgentId: "agent", body: `connection-proof.json ${proof.expected.nonce}` }] : [])],
      attachments: accepted ? [{ id: "artifact", issueId: "child", originalFilename: "connection-proof.json", createdByAgentId: "agent", originatingRunId: "child-run", byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] : [],
      comments: [{ id: "greeting", authorAgentId: "agent", body: "Welcome. What would you like to do?" }, ...(accepted ? [{ id: "completion", authorAgentId: "agent", body: "[QA-2](/QA/issues/child) [connection-proof.json](/api/attachments/artifact/content)" }] : [])],
    };
    options.mutate?.(phase, result);
    return result;
  };
  const api = {
    origin: "https://qa.example.test",
    async get(route: string) {
      const current = state();
      if (route.startsWith("/api/companies/company/issues?")) {
        expect(route).toContain("includeAgentCreatedTasks=true");
        return current.tasks;
      }
      if (route === "/api/companies/company/heartbeat-runs?limit=1000") return current.runs.map(row => ({ id: row.id }));
      if (route.startsWith("/api/heartbeat-runs/")) return current.runs.find(row => row.id === route.split("/").at(-1));
      if (route === "/api/issues/parent/interactions") return current.interactions;
      if (route === "/api/issues/parent/comments?order=asc") return current.comments;
      const match = route.match(/^\/api\/issues\/([^/]+)\/(documents|attachments)(?:\/([^/]+))?$/);
      if (match) {
        const rows: Row[] = current[match[2] as "documents" | "attachments"].filter(row => row.issueId === match[1]);
        return match[3] ? rows.find(row => row.key === decodeURIComponent(match[3]!)) : rows;
      }
      throw new Error(`Unexpected read: ${route}`);
    },
    async bytes(route: string) { expect(route).toBe("/api/attachments/artifact/content"); return bytes; },
  };
  const locator = (name: string): any => ({
    first() { return this; }, last() { return this; }, locator() { return this; },
    async click() {
      events.push(`click:${name}`);
      if (name === "Continue") phase = "proposal";
      if (name === "Approve" || name === "Confirm selection") phase = "accepted";
    },
    async check() { events.push(`check:${name}`); },
    async fill(text: string) { expect(text).toContain(title); events.push("fill:request"); },
    async waitFor() { events.push("visible:download"); expect(phase).toBe("accepted"); if (options.readbackFailure === "download-link") throw Error("synthetic download-link failure"); },
  });
  const page = {
    getByRole(_role: string, { name }: { name: string }) { return locator(name); },
    getByTestId(name: string) { return locator(name); },
    locator(selector: string) { expect(selector).toContain("/api/attachments/artifact/content"); return locator(selector); },
    async goto(url: string) { expect(url).toBe("https://qa.example.test/QA/issues/QA-1"); events.push("open:parent"); },
    async reload() { events.push("reload:parent"); if (options.readbackFailure === "reload") throw Error("synthetic reload failure"); },
  };
  const own = vi.fn(async (resource: { name: string; id?: string }) => { events.push(`own:${resource.id ?? resource.name}`); });
  const observeRun = vi.fn(async (row: Row) => { events.push(`run:${row.id}`); });
  const input = { context: { api, page, company: { id: "company", issuePrefix: "QA" }, environmentId: "environment" },
    agent: { id: "agent" }, connectionId: "connection", proof, campaignId: "campaign-1", maxRuns: 8,
    deadlineAt: Date.now() + 60_000, own, observeRun } as unknown as OnboardingFirstTaskInput;
  return { input, own, observeRun, events };
}

afterEach(() => { vi.restoreAllMocks(); vi.mocked(connectionDelay).mockReset().mockResolvedValue(undefined); });

describe("Cloud canonical onboarding first task", () => {
  it.each([
    ["unexpected task set", "unexpected_task_set", (state: Parameters<NonNullable<Options["mutate"]>>[1]) => { state.tasks.push({ id: "private-early-task", title: "private task text", status: "todo" }); }, { taskCount: 2 }],
    ["attachment", "attachment_present", (state: Parameters<NonNullable<Options["mutate"]>>[1]) => { state.attachments.push({ id: "private-attachment", issueId: "parent", originalFilename: "private-file.txt" }); }, { attachmentCount: 1 }],
    ["non-planning document", "non_planning_document_present", (state: Parameters<NonNullable<Options["mutate"]>>[1]) => { state.documents.push({ id: "private-document", issueId: "parent", key: "private-result-key", body: "private document body" }); }, { documentCount: 1, nonPlanningDocumentCount: 1 }],
    ["first task done", "first_task_done", (state: Parameters<NonNullable<Options["mutate"]>>[1]) => { state.tasks[0]!.status = "done"; }, { firstTaskStatus: "done", canonicalParentStatus: "done" }],
  ] as const)("retains the observed %s violation at the failing acceptance boundary", async (_label, violation, mutate, observed) => {
    const f = fixture({ mutate(phase, state) { if (phase === "proposal") mutate(state); } });
    const capture = vi.fn();
    f.input.onPreAcceptanceFailure = capture;
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ outcome: "failed", code: "onboarding_work_before_acceptance" });
    expect(capture).toHaveBeenCalledExactlyOnceWith({ version: 1, checkpoint: "awaiting-proposal", violations: [violation],
      taskCount: 1, attachmentCount: 0, documentCount: 0, nonPlanningDocumentCount: 0,
      firstTaskMatchesCanonicalParent: true, firstTaskStatus: "in_review", canonicalParentStatus: "in_review", ...observed });
    expect(() => validateOnboardingPreAcceptanceEvidence(JSON.parse(JSON.stringify(capture.mock.calls[0]![0])))).not.toThrow();
    const retained = JSON.stringify(capture.mock.calls[0]![0]);
    for (const text of ["private-", "parent", "proposal-run", "qa.example.test", "connection", "campaign-1"]) expect(retained).not.toContain(text);
    expect(f.events).not.toContain("click:Approve");
  });
  it("retains every simultaneous guard violation from the same failed snapshot", async () => {
    const f = fixture({ plan: true, mutate(phase, state) {
      if (phase !== "proposal") return;
      state.tasks[0]!.status = "done";
      state.tasks.push({ id: "private-early-task" });
      state.attachments.push({ id: "private-attachment", issueId: "parent" });
      state.documents.push({ id: "private-document", issueId: "parent", key: "private-result", body: "private body" });
    } });
    const capture = vi.fn();
    f.input.onPreAcceptanceFailure = capture;
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "onboarding_work_before_acceptance" });
    expect(capture).toHaveBeenCalledExactlyOnceWith({ version: 1, checkpoint: "awaiting-proposal",
      violations: ["unexpected_task_set", "attachment_present", "non_planning_document_present", "first_task_done"],
      taskCount: 2, attachmentCount: 1, documentCount: 2, nonPlanningDocumentCount: 1,
      firstTaskMatchesCanonicalParent: true, firstTaskStatus: "done", canonicalParentStatus: "done" });
    expect(f.events).not.toContain("click:Confirm selection");
  });
  it.each(["missing", "replaced", "reordered", "unknown-status"] as const)("records closed task observations when the snapshot is %s", async mode => {
    const f = fixture({ mutate(phase, state) {
      if (phase !== "proposal") return;
      if (mode === "missing") state.tasks = [];
      if (mode === "replaced") state.tasks = [{ id: "private-replacement", status: "done" }];
      if (mode === "reordered") state.tasks.unshift({ id: "private-first", status: "done" });
      if (mode === "unknown-status") { state.tasks[0]!.status = "private future status"; state.attachments.push({ id: "private-attachment", issueId: "parent" }); }
    } });
    const capture = vi.fn();
    f.input.onPreAcceptanceFailure = capture;
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "onboarding_work_before_acceptance" });
    expect(capture).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]![0]).toMatchObject({
      violations: mode === "unknown-status" ? ["attachment_present"] : mode === "missing" ? ["unexpected_task_set"] : ["unexpected_task_set", "first_task_done"],
      taskCount: mode === "missing" ? 0 : mode === "reordered" ? 2 : 1,
      firstTaskMatchesCanonicalParent: mode === "unknown-status",
      firstTaskStatus: mode === "missing" ? "missing" : mode === "unknown-status" ? "unknown" : "done",
      canonicalParentStatus: mode === "reordered" ? "in_review" : mode === "unknown-status" ? "unknown" : "missing",
    });
    expect(JSON.stringify(capture.mock.calls[0]![0])).not.toContain("private");
    expect(f.events).not.toContain("click:Approve");
  });
  it("retains an opening-boundary failure before the opening answer dispatches work", async () => {
    const f = fixture({ mutate(phase, state) { if (phase === "opening") state.tasks[0]!.status = "done"; } });
    const capture = vi.fn();
    f.input.onPreAcceptanceFailure = capture;
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "onboarding_work_before_acceptance" });
    expect(capture).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ checkpoint: "before-opening-answer", violations: ["first_task_done"] }));
    expect(f.events).not.toContain("click:Continue");
  });
  it("does not claim the first-slot Done guard when only a later canonical parent is Done", async () => {
    const f = fixture({ mutate(phase, state) {
      if (phase !== "proposal") return;
      state.tasks[0]!.status = "done";
      state.tasks.unshift({ id: "private-first", status: "todo" });
    } });
    const capture = vi.fn();
    f.input.onPreAcceptanceFailure = capture;
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "onboarding_work_before_acceptance" });
    expect(capture).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ violations: ["unexpected_task_set"],
      firstTaskMatchesCanonicalParent: false, firstTaskStatus: "todo", canonicalParentStatus: "done" }));
  });
  it.each([false, true])("does not retain failure snapshots during clean canonical success, plan mode %s", async plan => {
    const f = fixture({ plan });
    const capture = vi.fn();
    f.input.onPreAcceptanceFailure = capture;
    await expect(onboardingFirstTask(f.input)).resolves.toMatchObject({ onboardingIssueId: "parent", childIssueId: "child" });
    expect(capture).not.toHaveBeenCalled();
  });
  it.each(["reload", "download-link"] as const)("retains the independently verified download when later %s fails", async readbackFailure => {
    const f = fixture({ readbackFailure });
    const capture = vi.fn();
    f.input.onArtifact = capture;
    await expect(onboardingFirstTask(f.input)).rejects.toThrow(`synthetic ${readbackFailure} failure`);
    expect(capture).toHaveBeenCalledOnce();
    const retained = JSON.parse(JSON.stringify(capture.mock.calls[0]![0]));
    expect(() => validateOnboardingArtifact(retained)).not.toThrow();
    expect(JSON.parse(Buffer.from(retained.contentBase64, "base64").toString("utf8"))).toEqual(f.input.proof.expected);
    expect(retained.input).toBe(f.input.proof.input);
    expect(retained.originatingRunId).toBe("child-run");
  });
  it("retains the original download and independently generated expectation after JSON serialization", async () => {
    const f = fixture();
    const result = await onboardingFirstTask(f.input);
    const retained = JSON.parse(JSON.stringify({ productJourney: { artifact: result.artifact } })).productJourney.artifact;
    const bytes = Buffer.from(retained.contentBase64, "base64");
    expect(bytes.toString("utf8")).toBe(JSON.stringify(f.input.proof.expected));
    expect(retained.byteSize).toBe(bytes.byteLength);
    expect(retained.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(retained.input).toBe(f.input.proof.input);
    expect(retained.expected).toEqual(f.input.proof.expected);
    expect(retained.expected.sha256).toBe(createHash("sha256").update(retained.input).digest("hex"));
  });
  it.each([false, true])("answers the opening and approves one child, including plan mode %s", async plan => {
    const f = fixture({ plan });
    const result = await onboardingFirstTask(f.input);
    expect(result).toMatchObject({ onboardingIssueId: "parent", childIssueId: "child", artifact: { id: "artifact", originatingRunId: "child-run" } });
    expect(result.runIds).toEqual(["proposal-run", "acceptance-run", "child-run", "completion-run"]);
    expect(f.events.indexOf("own:Artifact campaign-1")).toBeLessThan(f.events.indexOf("click:Continue"));
    expect(f.events.indexOf("run:proposal-run")).toBeLessThan(f.events.indexOf(plan ? "click:Confirm selection" : "click:Approve"));
    expect(f.events.at(-1)).toBe("visible:download");
    expect(f.own).toHaveBeenCalledWith({ kind: "issue", name: "Artifact campaign-1", id: "child" });
    expect(f.observeRun).toHaveBeenCalledTimes(4);
  });
  it("refuses premature child creation without approving it", async () => {
    const f = fixture({ mutate(phase, state) { if (phase === "proposal") state.tasks.push({ id: "early", title: "Artifact campaign-1" }); } });
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "onboarding_work_before_acceptance" });
    expect(f.events).not.toContain("click:Approve");
  });
  it("does not accept a proposal that omits the intended campaign child", async () => {
    const f = fixture({ mutate(phase, state) { if (phase === "proposal") state.interactions[1]!.payload.prompt = "Create an unrelated task"; } });
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "onboarding_proposal_child_title_mismatch" });
    expect(f.events).not.toContain("click:Approve");
  });
  it("observes but rejects model work before the opening answer", async () => {
    const f = fixture({ mutate(phase, state) { if (phase === "opening") state.runs.push({ id: "unexpected", status: "running" }); } });
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "onboarding_opening_started_model_work" });
    expect(f.observeRun).toHaveBeenCalledTimes(1);
    expect(f.events).not.toContain("click:Continue");
  });
  it.each(["no-child", "duplicate", "wrong-title"])("rejects an approved scope violation: %s", async mode => {
    const f = fixture({ mutate(phase, state) {
      if (phase !== "accepted") return;
      if (mode === "no-child") state.tasks.pop();
      if (mode === "duplicate") state.tasks.push({ ...state.tasks[1]!, id: "extra" });
      if (mode === "wrong-title") state.tasks[1]!.title = "Unowned child";
    } });
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: mode === "no-child" ? "onboarding_completed_without_child" : "onboarding_approved_child_mismatch" });
  });
  it.each(["parent-run", "wrong-connection", "bad-hash", "missing-document", "missing-parent-links"])("does not pass an unverified deliverable: %s", async mode => {
    const f = fixture({ mutate(phase, state) {
      if (phase !== "accepted") return;
      if (mode === "parent-run") state.attachments[0]!.originatingRunId = "acceptance-run";
      if (mode === "wrong-connection") state.runs[2]!.contextSnapshot.aiConnection.connectionId = "other";
      if (mode === "bad-hash") state.attachments[0]!.sha256 = "0".repeat(64);
      if (mode === "missing-document") state.documents = [];
      if (mode === "missing-parent-links") state.comments.pop();
    } });
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: mode === "bad-hash" ? "artifact_independent_check_failed" : mode === "missing-document" ? "onboarding_child_document_missing" : mode === "missing-parent-links" ? "onboarding_parent_result_links_missing" : "artifact_run_attribution_mismatch" });
    expect(f.events).not.toContain("visible:download");
  });
  it("counts proposal and parent runs toward the campaign cap", async () => {
    const f = fixture(); f.input.maxRuns = 3;
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "campaign_run_limit_exceeded" });
    expect(f.observeRun).toHaveBeenCalledTimes(4);
  });
  it("independently rejects a wrong result even when size and download hash are correct", async () => {
    const f = fixture({ wrongProof: true });
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "artifact_independent_check_failed" });
    expect(f.events).not.toContain("visible:download");
  });
  it("waits for parent completion and stops at the campaign deadline", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(connectionDelay).mockImplementation(async ms => { now += ms; });
    const f = fixture({ mutate(phase, state) { if (phase === "accepted") state.tasks[0]!.status = "blocked"; } });
    f.input.deadlineAt = now + 2000;
    await expect(onboardingFirstTask(f.input)).rejects.toMatchObject({ code: "onboarding_first_task_deadline" });
    expect(f.events).not.toContain("visible:download");
  });
  it("retains an ordinary blocked unstarted wake without mistaking it for paid failure", async () => {
    const f = fixture({ mutate(phase, state) {
      if (phase === "accepted") state.runs.push({ ...state.runs[0]!, id: "obsolete-wake", status: "cancelled", errorCode: "issue_dependencies_blocked", startedAt: null });
    } });
    expect((await onboardingFirstTask(f.input)).runIds).toContain("obsolete-wake");
  });
});
