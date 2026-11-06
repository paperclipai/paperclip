import { describe, expect, it, vi } from "vitest";
import { buildHistoricalWebsiteImport, gradeArtifactSearch, historicalWebsitePreviewMatches, readReturnedWebsiteFiles } from "./internal-artifact-search.js";
import { parse } from "yaml";
import { companyPortabilityService } from "../../../server/src/services/company-portability.js";
function valid() {
  const target = { id: "final-task", companyId: "company", title: "Final launch website delivery", status: "done", completedAt: "2026-10-21T12:00:00.000Z" };
  const hidden = { id: "hidden-task", companyId: "company", title: "Restricted final website NIGHTJAR", status: "done" };
  const file = { companyId: "company", byteSize: 115, originalFilename: "final-website.html", id: "file", issueId: "final-task", assetId: "asset", issueCommentId: "delivery", sha256: "a".repeat(64), contentPath: "/api/attachments/file/content", createdAt: "2026-10-26T12:00:00.000Z" };
  const history = [{ issueId: target.id, comments: [{ id: "delivery", body: "original", createdAt: target.completedAt }], attachments: [structuredClone(file)] }, { issueId: hidden.id, comments: [], attachments: [] }];
  return { chatIssueId: "chat", returnedFiles: [{ attachment: structuredClone(file), downloadedHash: file.sha256, byteSize: 115 }], sourceHistory: structuredClone(history), scenarioId: "documents-artifacts.find-artifact", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { task: structuredClone(target), privateTask: hidden, privateMarker: hidden.title, privateAttachment: { id: "hidden-file", assetId: "hidden-asset" }, finalAttachment: structuredClone(file), finalHash: file.sha256, deliveryAt: target.completedAt, weekStart: Date.parse("2026-10-19T00:00:00Z"), weekEnd: Date.parse("2026-10-26T00:00:00Z"), originalHistory: structuredClone(history), originalTasks: structuredClone([target, hidden]), distractors: [hidden] },
    tasks: [target, hidden], projects: [], goals: [], comments: [], activity: [{ id: "import", action: "company.imported", createdAt: "2026-10-26T12:00:01.000Z" }], documents: [], revisions: [], runs: [{ id: "source-run", status: "succeeded" }], humanQueries: [],
    reply: "This is the final approved website delivered last week; the import uploaded the preserved file again today.", links: ["/RUN/issues/final-task", "/api/attachments/file/content?download=1"],
    finalAttachment: file, currentSource: target, downloadedHash: file.sha256, deliveryComments: [{ id: "delivery", createdAt: target.completedAt, body: `Final approved website delivered, SHA256 ${file.sha256}.` }], searchStatus: 200, searchResults: [{ id: "final-task" }], privateFileStatus: 403 };
}
describe("migrated historical website artifact calibration", () => {
  it("accepts preserved original last-week delivery and actual later import", () => expect(gradeArtifactSearch(valid()).passed).toBe(true));
  it.each([
    "This is the final approved website delivered on October 21, 2026; today was only its import.",
    "The final website was delivered 21 October 2026.",
    "The approved final was delivered Oct 21.",
    "The final was delivered 2026-10-21 and imported October 26, 2026.",
    "The earlier draft wasn't delivered October 20, 2026; the final website was delivered October 21, 2026.",
    "I didn't change the files; the final website was delivered October 21, 2026.",
  ])("accepts correct source dates without a literal last-week phrase: %s", reply => {
    const o = valid(); o.reply = reply; expect(gradeArtifactSearch(o).passed).toBe(true);
  });
  it.each([
    "The final approved website was delivered October 22, 2026.",
    "The final approved website was delivered October 21, 2025.",
    "The final approved website was delivered last week, on October 26, 2026.",
    "The final approved website was not delivered last week.",
    "The final approved website was not delivered on October 21, 2026.",
    "The final approved website wasn't delivered on October 21, 2026.",
    "The final approved website wasn’t delivered last week.",
  ])("rejects wrong or contradicted delivery dates: %s", reply => {
    const o = valid(); o.reply = reply; expect(gradeArtifactSearch(o).passed).toBe(false);
  });
  it("does not let natural-date wording rescue wrong final bytes or source", () => {
    const bytes = valid(); bytes.reply = "Final website delivered October 21, 2026."; bytes.downloadedHash = "b".repeat(64);
    expect(gradeArtifactSearch(bytes).passed).toBe(false);
    const source = valid(); source.reply = bytes.reply; source.finalAttachment.issueId = "draft-task";
    expect(gradeArtifactSearch(source).passed).toBe(false);
  });
  it("accepts an independently downloaded, attributed response copy without changing source history", () => {
    const o = valid(); const copy = { ...o.finalAttachment, id: "copy", issueId: "chat", contentPath: "/api/attachments/copy/content", createdByAgentId: "ceo", originatingRunId: "source-run" };
    o.links[1] = copy.contentPath; o.returnedFiles = [{ attachment: copy, downloadedHash: copy.sha256, byteSize: copy.byteSize }];
    o.activity.push({ id: "copy-added", action: "issue.attachment_added", agentId: "ceo", entityId: "chat" } as never);
    expect(gradeArtifactSearch(o).passed).toBe(true);
    for (const change of [
      { downloadedHash: "b".repeat(64) }, { byteSize: 114 },
      { attachment: { ...copy, companyId: "foreign" } }, { attachment: { ...copy, issueId: "other-chat" } },
      { attachment: { ...copy, createdByAgentId: "other" } }, { attachment: { ...copy, originatingRunId: "old-run" } },
      { attachment: { ...copy, sha256: "b".repeat(64) } }, { attachment: { ...copy, originalFilename: "draft.html" } },
    ]) { const wrong = structuredClone(o); wrong.returnedFiles[0] = { ...wrong.returnedFiles[0]!, ...change }; expect(gradeArtifactSearch(wrong).passed).toBe(false); }
    const absent = structuredClone(o); absent.returnedFiles = []; expect(gradeArtifactSearch(absent).passed).toBe(false);
  });
  it("rejects historical task, comment, attachment, or completion mutation while allowing current-chat delivery", () => {
    for (const mutate of [
      (o: ReturnType<typeof valid>) => { o.tasks[0]!.title = "Changed"; },
      (o: ReturnType<typeof valid>) => { (o.tasks[0]! as typeof o.currentSource).completedAt = "2026-10-22T12:00:00Z"; },
      (o: ReturnType<typeof valid>) => { o.sourceHistory[0]!.comments[0]!.body = "changed"; },
      (o: ReturnType<typeof valid>) => { o.sourceHistory[0]!.attachments[0]!.sha256 = "b".repeat(64); },
      (o: ReturnType<typeof valid>) => { o.sourceHistory = []; },
      (o: ReturnType<typeof valid>) => { o.activity.push({ id: "mutation", action: "issue.updated", agentId: "ceo", entityId: "final-task" } as never); },
    ]) { const o = valid(); mutate(o); expect(gradeArtifactSearch(o).passed).toBe(false); }
  });
  it("does not mistake explicitly excluded other-source dates for the selected delivery date", () => {
    const o = valid(); const old = { id: "old-task", identifier: "RUN-2", companyId: "company", title: "Earlier final", status: "done" };
    o.state.distractors.push(old); o.reply = "Found the final website delivered 2026-10-21.\nNot the others: RUN-2 old-final.html is from 2026-09-30, and the draft was never delivered.";
    expect(gradeArtifactSearch(o).passed).toBe(true);
    for (const reply of [
      "The final was delivered 2026-10-22.\nNot the others: RUN-2 from 2026-09-30.",
      "The final wasn't delivered 2026-10-21.\nNot the others: RUN-2 from 2026-09-30.",
      "The final was delivered 2026-10-21.\nNot the others: final-task was delivered 2026-10-22; RUN-2 from 2026-09-30.",
      "The final was delivered 2026-10-21.\nNot the others: unknown-task from 2026-09-30.",
      "The final was delivered 2026-10-21.\nNot the others: RUN-2 from 2026-09-30; the final was delivered 2026-10-22.",
    ]) { const wrong = structuredClone(o); wrong.reply = reply; expect(gradeArtifactSearch(wrong).passed).toBe(false); }
  });
  it("observes the actual rendered copy with authenticated byte reads and no raw-request fallback", async () => {
    const o = valid(); const body = Buffer.from("actual copied file"); const hash = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
    o.state.finalHash = hash; o.state.finalAttachment.byteSize = body.length;
    const copy = { ...o.finalAttachment, companyId: "company", id: "copy", issueId: "chat", contentPath: "/api/attachments/copy/content", sha256: hash, byteSize: body.length };
    o.links = [copy.contentPath]; const read = vi.fn().mockResolvedValue(body); const raw = vi.fn(() => { throw new Error("raw transport forbidden"); });
    const ctx = { issue: () => ({ id: "chat" }), input: { api: { get: vi.fn().mockImplementation((path: string) => Promise.resolve(path.includes("/chat/") ? [copy] : [o.finalAttachment])), getAttachmentContent: read, request: { get: raw } } } };
    const result = await readReturnedWebsiteFiles(ctx as never, o as never);
    expect(read).toHaveBeenCalledExactlyOnceWith("copy"); expect(result).toEqual([{ attachment: copy, downloadedHash: hash, byteSize: body.length }]); expect(raw).not.toHaveBeenCalled();
    o.links = ["https://foreign.test" + copy.contentPath]; expect(await readReturnedWebsiteFiles(ctx as never, o as never)).toEqual([]);
    o.links = [copy.contentPath]; read.mockRejectedValue(new Error("403")); await expect(readReturnedWebsiteFiles(ctx as never, o as never)).rejects.toThrow("403");
  });
  it("builds real inline migration files with SHA-bound bytes and comment linkage", () => { const bundle = buildHistoricalWebsiteImport("2026-10-21T12:00:00.000Z", "ORCHID"); const yaml = parse(bundle.files[".paperclip.yaml"] as string); expect(yaml.schemaVersion).toBe(7); for (const row of bundle.receipts) { expect(bundle.files[`blobs/${row.sha256}`]).toMatchObject({ encoding: "base64" }); expect(yaml.tasks[row.slug].attachments[0]).toMatchObject({ sha256: row.sha256, commentIndex: 0 }); } expect(yaml.tasks["final-website"].completedAt).toBe("2026-10-21T12:00:00.000Z"); });
  it("passes the actual production portability parser with all original dates/comments/attachments and no database access", async () => {
    const bundle = buildHistoricalWebsiteImport("2026-10-21T12:00:00.000Z", "ORCHID");
    const noDatabase = new Proxy({}, { get(_target, key) { throw new Error(`Offline preview must not access database property ${String(key)}`); } }) as Parameters<typeof companyPortabilityService>[0];
    const service = companyPortabilityService(noDatabase);
    const request = { source: { type: "inline" as const, files: bundle.files }, include: { company: false, agents: false, projects: false, issues: true, skills: false }, target: { mode: "new_company" as const }, collisionStrategy: "rename" as const };
    const preview = await service.previewImport(request);
    expect(historicalWebsitePreviewMatches(preview, bundle)).toBe(true);
    const jsonRoot = { ...request, source: { ...request.source, files: { ...bundle.files, ".paperclip.yaml": JSON.stringify(parse(bundle.files[".paperclip.yaml"] as string)) } } };
    const lost = await service.previewImport(jsonRoot);
    expect(lost.manifest.issues).toHaveLength(4);
    expect(lost.manifest.issues.every(row => row.attachments?.length === 0 && row.completedAt == null)).toBe(true);
    expect(historicalWebsitePreviewMatches(lost, bundle)).toBe(false);
    const wrongDate = structuredClone(preview); wrongDate.manifest.issues.find(row => row.slug === "final-website")!.completedAt = "2026-10-27T12:00:00.000Z";
    expect(historicalWebsitePreviewMatches(wrongDate, bundle)).toBe(false);
    const wrongComment = structuredClone(preview); wrongComment.manifest.issues.find(row => row.slug === "final-website")!.attachments![0]!.commentIndex = 1;
    expect(historicalWebsitePreviewMatches(wrongComment, bundle)).toBe(false);
  });
  it("accepts an explicitly qualified link to older authorized history", () => { const o = valid(); const old = { id: "old-task", companyId: "company", title: "Earlier website final", status: "done" }; o.state.distractors.push(old); o.links.push("/RUN/issues/old-task"); o.reply += "\n[Earlier website final](/RUN/issues/old-task) is older history outside last week."; expect(gradeArtifactSearch(o).passed).toBe(true); });
  it("rejects treating today's import as last week's delivery", () => { const o = valid(); o.currentSource.completedAt = "2026-10-26T12:00:00.000Z"; expect(gradeArtifactSearch(o).passed).toBe(false); });
  it("rejects invented attachment-bound source history", () => { const o = valid(); o.deliveryComments[0]!.id = "wrong-comment"; expect(gradeArtifactSearch(o).passed).toBe(false); const noImport = valid(); noImport.activity = []; expect(gradeArtifactSearch(noImport).passed).toBe(false); });
  it("rejects private snippets or copied private file links", () => { const o = valid(); o.searchResults.push({ id: "hidden-task" }); expect(gradeArtifactSearch(o).passed).toBe(false); const leak = valid(); leak.links.push("/api/attachments/hidden-file/content"); expect(gradeArtifactSearch(leak).passed).toBe(false); });
  it("rejects foreign downloads, stale bytes and older final source substitution", () => { const o = valid(); o.links[1] = "https://foreign.test/api/attachments/file/content"; expect(gradeArtifactSearch(o).passed).toBe(false); const stale = valid(); stale.downloadedHash = "b".repeat(64); expect(gradeArtifactSearch(stale).passed).toBe(false); const older = valid(); older.state.deliveryAt = "2026-09-30T12:00:00.000Z"; older.currentSource.completedAt = older.state.deliveryAt; expect(gradeArtifactSearch(older).passed).toBe(false); });
});
