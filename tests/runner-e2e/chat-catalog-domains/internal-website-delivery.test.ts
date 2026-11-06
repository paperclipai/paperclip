import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gradeWebsiteDelivery, websitePrerequisiteSettled } from "./internal-website-delivery.js";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
it("keeps generated-but-undelivered work honestly blocked until the canonical delivery request", () => {
  const staged = { task: { id: "task", status: "blocked" }, runs: [{ agentId: "morgan", status: "succeeded" }] };
  expect(websitePrerequisiteSettled(staged, "morgan", false)).toBe(true);
  expect(websitePrerequisiteSettled(staged, "morgan", true)).toBe(false);
  expect(websitePrerequisiteSettled({ ...staged, runs: [{ agentId: "morgan", status: "failed" }] }, "morgan", false)).toBe(false);
  expect(websitePrerequisiteSettled({ ...staged, runs: [{ agentId: "unrelated", status: "succeeded" }] }, "morgan", false)).toBe(false);
});
function valid(revising = false) {
  const task = { id: "task", companyId: "company", title: "Website task", status: "done", assigneeAgentId: "ceo" };
  const prior = "<html><body><h1>Bring your research team notes together in one accessible place</h1><p>Research teams stay organized.</p><a href='https://example.test/signup'>Signup</a><footer>ORCHID</footer></body></html>";
  const body = revising ? prior.replace("Bring your research team notes together in one accessible place", "Notes, together") : prior;
  const attachment = (id: string, bytes: string, run: string) => ({ id, issueId: "task", sha256: hash(bytes), originatingRunId: run, contentPath: `/api/attachments/${id}/content` });
  const product = (id: string, file: string, run: string) => ({ id, issueId: "task", type: "artifact", provider: "paperclip", status: "active", createdByRunId: run, metadata: { attachmentId: file } });
  const original = attachment("original", prior, "build"); const newFile = attachment("new", body, "run");
  return { scenarioId: revising ? "documents-artifacts.revise-delivery" : "documents-artifacts.produce-download", origin: "https://fixture.test", companyId: "company", leadId: "ceo",
    state: { task: structuredClone(task), worker: { id: "morgan" }, priorRunId: "build", producedBody: prior, producedHash: hash(prior), bodyFact: "Research teams stay organized.", signupHref: "https://example.test/signup", marker: "ORCHID", originalAttachment: original, originalProductId: "old-product" },
    tasks: [task], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], humanQueries: [], links: ["/RUN/issues/task", "/api/attachments/new/content?download=1"],
    reply: "The updated shorter version is downloadable; the original remains available.", runs: [{ id: "run", companyId: "company", agentId: "ceo", status: "succeeded" }, { id: "build", companyId: "company", agentId: "morgan", status: "succeeded" }],
    attachments: [newFile, ...(revising ? [original] : [])], products: [product("new-product", "new", "run"), ...(revising ? [product("old-product", "original", "build")] : [])], downloaded: [{ id: "new", sha256: hash(body), body }, ...(revising ? [{ id: "original", sha256: hash(prior), body: prior }] : [])] };
}
describe("registered website delivery calibration", () => {
  it.each([false, true])("accepts actual registered and downloaded website bytes, revision=%s", revising => expect(gradeWebsiteDelivery(valid(revising)).passed).toBe(true));
  it("rejects a local path without registered download", () => { const o = valid(); o.links = ["/RUN/issues/task", "/tmp/website.html"]; expect(gradeWebsiteDelivery(o).passed).toBe(false); });
  it("rejects stale or mismatched downloaded bytes", () => { const o = valid(); o.downloaded[0]!.body = "<html>stale</html>"; expect(gradeWebsiteDelivery(o).passed).toBe(false); });
  it("rejects wrong immutable origin or work-product source", () => { const o = valid(); o.attachments[0]!.originatingRunId = "build"; expect(gradeWebsiteDelivery(o).passed).toBe(false); const source = valid(true); source.products[0]!.issueId = "another-task"; expect(gradeWebsiteDelivery(source).passed).toBe(false); });
  it("rejects overwriting the only old copy", () => { const o = valid(true); o.downloaded = o.downloaded.filter(row => row.id !== "original"); expect(gradeWebsiteDelivery(o).passed).toBe(false); });
  it("rejects a headline that was not shortened", () => { const o = valid(true); o.downloaded[0]!.body = o.state.producedBody; o.downloaded[0]!.sha256 = hash(o.downloaded[0]!.body); o.attachments[0]!.sha256 = o.downloaded[0]!.sha256; expect(gradeWebsiteDelivery(o).passed).toBe(false); });
  it("rejects a shorter headline with unrelated body edits", () => { const o = valid(true); o.downloaded[0]!.body = o.downloaded[0]!.body.replace("Research teams stay organized.", "Ads for sale."); o.downloaded[0]!.sha256 = hash(o.downloaded[0]!.body); o.attachments[0]!.sha256 = o.downloaded[0]!.sha256; expect(gradeWebsiteDelivery(o).passed).toBe(false); });
});
