import { describe, expect, it, vi } from "vitest";
import { SkillSourceUpdateReadError } from "../api.js";
import { readFileSync } from "node:fs";
import { accessibilityUpdatePins as pins, gradeIntegratorSkillUpdate, requireSkillUpdatePrerequisite, integratorSkillUpdateCases, acceptedSkillReviewRun } from "./integrator-skill-update.js";
// Unmodified MIT-licensed source bytes, with LICENSE.md in the same fixture
// directory. Product setup still fetches the actual GitHub commit snapshots.
import { createHash } from "node:crypto";
import { saveSkillConversationContext } from "./integrator-skill-context.js";
vi.mock("./integrator-skill-context.js", () => ({ saveSkillConversationContext: vi.fn(async () => ({})) }));
vi.mock("./integrator-skill-source.js", () => ({ editableLocalNotes: async () => ({ id: "local", currentVersionId: "local-version" }) }));
vi.mock("./integrator-skill-versions.js", () => ({ readSkillVersionHistory: async () => [] }));

const bytes = { old: readFileSync(new URL("../fixtures/accessibility-source/0.4.SKILL.md", import.meta.url), "utf8"), next: readFileSync(new URL("../fixtures/accessibility-source/0.5.SKILL.md", import.meta.url), "utf8") };
function valid(old: string, next: string) {
  const upstream = { id: "up", companyId: "company", name: "accessibility", editable: false, sourceRef: pins.oldCommit, currentVersionId: "old", markdown: old };
  const local = { id: "fork", editable: true, forkedFromSkillId: "up", currentVersionId: "local", markdown: `${old}\nORCHID customer notes` };
  const versions = [{ id: "old", fileInventory: [{ path: "SKILL.md", content: old }] }]; const localVersions = [{ id: "local" }];
  const base = { scenarioId: "skills.review-update", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { upstream: structuredClone(upstream), localFork: structuredClone(local), localVersions: structuredClone(localVersions) }, upstream, localFork: local, upstreamVersions: versions, forkVersions: localVersions,
    source: { id: "source", lastScanCommit: pins.oldCommit, trackingRef: pins.newCommit, automaticUpdates: false }, updateStatus: { supported: true, hasUpdate: true, currentRef: pins.oldCommit, latestRef: pins.newCommit },
    tasks: [], projects: [], goals: [], documents: [], revisions: [], comments: [], humanQueries: [], links: [], runs: [], activity: [],
    reply: "The currently installed version is 0.4. The new revision adds continuous accessibility regression tests and splits long forms into smaller steps; it also discourages crowded interface patterns. I have not applied it." };
  return { ...base, upstream: { ...upstream, sourceRef: pins.newCommit, currentVersionId: "new", markdown: next }, source: { ...base.source, lastScanCommit: pins.newCommit },
    upstreamVersions: [...versions, { id: "new", fileInventory: [{ path: "SKILL.md", content: next }] }], activity: [{ agentId: "ceo", action: "company.skill_source_refreshed", entityId: "source" }], state: { ...base.state, reviewCheckpoint: structuredClone(base) },
    reply: `${base.reply}\nI updated the accessibility skill to the reviewed source version. The local copy is unchanged.` };
}
describe("genuine immutable public skill update qualification", () => {
  it("retains two independently qualified distinct public hashes without credential prerequisites", () => {
    expect(pins.oldCommit).not.toBe(pins.newCommit); expect(pins.oldSha256).not.toBe(pins.newSha256);
    expect(pins.repositoryURL).toBe("https://github.com/KreerC/ACCESSIBILITY.md");
  });
  it("accepts substantive review, normal saved version update and preserved fork using actual source bytes", () => {
    expect(createHash("sha256").update(bytes.old).digest("hex")).toBe(pins.oldSha256); expect(createHash("sha256").update(bytes.next).digest("hex")).toBe(pins.newSha256);
    expect(gradeIntegratorSkillUpdate(valid(bytes.old, bytes.next)).passed).toBe(true); expect(gradeIntegratorSkillUpdate(undefined).passed).toBe(false);
    const natural = valid(bytes.old, bytes.next); natural.reply = `${natural.state.reviewCheckpoint.reply}\nThe accessibility skill is now on revision 0.5; our local fork is preserved.`; expect(gradeIntegratorSkillUpdate(natural).passed).toBe(true);
  });
  it("accepts a truthful not-applied review but rejects a later positive claim or changed saved version", () => {
    const truthful = valid(bytes.old, bytes.next);
    truthful.state.reviewCheckpoint.reply = truthful.state.reviewCheckpoint.reply.replace("I have not applied it.", "No update applied yet.");
    truthful.reply = `${truthful.state.reviewCheckpoint.reply}\nI updated the accessibility skill to the reviewed source version. The local copy is unchanged.`;
    expect(gradeIntegratorSkillUpdate(truthful).passed).toBe(true);
    const contradictory = structuredClone(truthful);
    contradictory.state.reviewCheckpoint.reply += " The update is applied.";
    expect(gradeIntegratorSkillUpdate(contradictory).checks.find(check => check.id === "review-diff-before-update")?.passed).toBe(false);
    const changed = structuredClone(truthful);
    changed.state.reviewCheckpoint.upstream.currentVersionId = "premature";
    expect(gradeIntegratorSkillUpdate(changed).checks.find(check => check.id === "review-diff-before-update")?.passed).toBe(false);
  });

  it("admits only a visible committed current-run review alongside the shorter final comment", () => {
    const value = valid(bytes.old, bytes.next);
    const first = value.state.reviewCheckpoint as typeof value.state.reviewCheckpoint & { visibleReview?: unknown };
    Object.assign(first.state, { sourceIssueId: "source" });
    const summary = first.reply;
    const run = { id: "review-run", runtimeMode: "native", companyId: "company", agentId: "ceo", status: "succeeded", nativeIssueId: "source",
      contextSnapshot: { issueId: "source", commentId: "human" }, resultJson: { summary, finalizationPhase: "committed",
        finalizationReasonCode: "conversation_turn_finished", prpRunTerminalState: "succeeded", prpTurnTerminalState: "completed",
        nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary } } };
    Object.assign(first, { runs: [run], reply: "The complete diff is shown above. No update applied yet." });
    value.reply = `${first.reply}\nI updated the accessibility skill to the reviewed source version. The local copy is unchanged.`;
    const check = () => gradeIntegratorSkillUpdate(value).checks.find(row => row.id === "review-diff-before-update")?.passed;
    expect(check()).toBe(false); // An API-only summary never substitutes for visible review.
    first.visibleReview = { runId: run.id, issueId: "source", humanCommentId: "human", summary, visibleText: summary };
    expect(check()).toBe(true);
    expect(gradeIntegratorSkillUpdate(value).passed).toBe(true); // Raw final-comment prefix still proves later apply.
    for (const patch of [{ runId: "old" }, { issueId: "foreign" }, { humanCommentId: "old-human" }, { summary: "foreign" }, { visibleText: "" }, { visibleText: "Installed 0.4; latest 0.5 exists." }]) {
      const original = first.visibleReview; first.visibleReview = { ...original as object, ...patch };
      expect(check()).toBe(false); first.visibleReview = original;
    }
    for (const patch of [{ companyId: "foreign" }, { agentId: "foreign" }, { status: "failed" }, { nativeIssueId: "foreign" }, { contextSnapshot: { issueId: "source", commentId: "other" } }, { resultJson: { ...run.resultJson, finalizationPhase: "pending" } }]) {
      const original = first.runs; Object.assign(first, { runs: [{ ...run, ...patch }] });
      expect(check()).toBe(false); first.runs = original;
    }
    const originalVersion = first.upstream.currentVersionId; first.upstream.currentVersionId = "premature";
    expect(check()).toBe(false); first.upstream.currentVersionId = originalVersion;
    expect(acceptedSkillReviewRun(first, "foreign")).toBeUndefined();
  });

  it("rejects premature apply, listing-only review, stale installation and overwritten local work", () => {
    const early = valid(bytes.old, bytes.next); early.state.reviewCheckpoint.upstream.currentVersionId = "new"; expect(gradeIntegratorSkillUpdate(early).passed).toBe(false);
    const listing = valid(bytes.old, bytes.next); listing.state.reviewCheckpoint.reply = "Current installed 0.4. Latest 0.5 is available."; expect(gradeIntegratorSkillUpdate(listing).passed).toBe(false);
    const stale = valid(bytes.old, bytes.next); stale.upstream.markdown = bytes.old; expect(gradeIntegratorSkillUpdate(stale).passed).toBe(false);
    const overwritten = valid(bytes.old, bytes.next); overwritten.localFork.markdown = bytes.next; expect(gradeIntegratorSkillUpdate(overwritten).passed).toBe(false);
    const lying = valid(bytes.old, bytes.next); lying.reply = `${lying.state.reviewCheckpoint.reply}\nI haven't updated the accessibility skill, only fetched its source.`; expect(gradeIntegratorSkillUpdate(lying).passed).toBe(false);
  });
});

it("requires the actual pinned update prerequisite before admitting the human request", async () => {
  const real = { supported: true, hasUpdate: true, currentRef: pins.oldCommit, latestRef: pins.newCommit, trackingRef: pins.newCommit };
  const evidence = vi.fn(async (_name: string, _value: unknown) => {});
  const read = vi.fn(async (): Promise<{ supported: boolean; hasUpdate: boolean; currentRef: string; latestRef: string; trackingRef: string }> => real);
  const ctx = { observationDeadlineAt: Date.now() + 30_000, input: { api: { getSkillSourceUpdateStatus: read }, fixtures: { company: { id: "company" } }, evidence } } as unknown as Parameters<typeof requireSkillUpdatePrerequisite>[0];
  await requireSkillUpdatePrerequisite(ctx, "selected"); expect(read).toHaveBeenCalledWith("company", "selected", { timeout: expect.any(Number) });
  expect(evidence).toHaveBeenCalledWith("chat-skill-update-prerequisite.json", expect.objectContaining({ currentPinnedRevisionMatched: true, latestPinnedRevisionMatched: true }));
  for (const bad of [{ ...real, supported: false }, { ...real, hasUpdate: false }, { ...real, currentRef: pins.newCommit }, { ...real, latestRef: pins.oldCommit }, { ...real, trackingRef: "wrong" }]) {
    read.mockResolvedValueOnce(bad); await expect(requireSkillUpdatePrerequisite(ctx, "selected")).rejects.toThrow("unavailable");
  }
  read.mockRejectedValueOnce(new Error("closed HTTP error")); await expect(requireSkillUpdatePrerequisite(ctx, "selected")).rejects.toThrow("closed HTTP error");
  expect(evidence).toHaveBeenCalledOnce();
});

function setupFixture(unavailable: boolean) {
  const source = { id: "source", revision: 1, entries: [{ path: pins.path, skillId: "up" }], lastScanCommit: pins.oldCommit, trackingRef: pins.newCommit, automaticUpdates: false };
  const prerequisite = vi.fn(async () => { if (unavailable) throw new SkillSourceUpdateReadError(422, "skill_source_ref_unavailable", 422);
    return { supported: true, hasUpdate: true, currentRef: pins.oldCommit, latestRef: pins.newCommit, trackingRef: pins.newCommit }; });
  const ctx = { observationDeadlineAt: Date.now() + 30_000, input: { fixtures: { company: { id: "company" } }, evidence: vi.fn(async (_name: string, _value: unknown) => {}), api: {
    post: async () => ({ source, imported: [{ id: "up" }] }), patch: async () => source,
    get: async () => ({ id: "up", sourceType: "github", sourceRef: pins.oldCommit, markdown: bytes.old, editable: false }), getSkillSourceUpdateStatus: prerequisite,
  } } } as unknown as Parameters<typeof requireSkillUpdatePrerequisite>[0];
  return { ctx, prerequisite };
}
it("actual review-update setup blocks an unavailable dependency before preparing the canonical human request", async () => {
  vi.mocked(saveSkillConversationContext).mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url.includes(pins.oldCommit) ? bytes.old : bytes.next)));
  try {
    const f = setupFixture(true); await expect(integratorSkillUpdateCases[0]!.setup(f.ctx)).rejects.toMatchObject({ name: "SkillSourceUpdateReadError", reason: "skill_source_ref_unavailable" });
    expect(f.prerequisite).toHaveBeenCalledOnce(); expect(saveSkillConversationContext).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
it("actual review-update setup keeps the real prerequisite and then prepares the unchanged source-aware request", async () => {
  vi.mocked(saveSkillConversationContext).mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url.includes(pins.oldCommit) ? bytes.old : bytes.next)));
  try {
    const f = setupFixture(false); const result = await integratorSkillUpdateCases[0]!.setup(f.ctx);
    expect(f.prerequisite).toHaveBeenCalledOnce(); expect(saveSkillConversationContext).toHaveBeenCalledOnce(); expect(result.source).toMatchObject({ trackingRef: pins.newCommit, lastScanCommit: pins.oldCommit });
  } finally { vi.unstubAllGlobals(); }
});
