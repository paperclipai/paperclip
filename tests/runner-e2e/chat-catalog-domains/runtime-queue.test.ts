import { it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { gradeQueuedFollowup, promptCarriesComment, zipEntryTexts } from "./runtime-queue.js";
/** A minimal zip with one deflated and one stored entry, laid out as zip tools write it. */
function zip(entries: Array<{ name: string; text: string; deflate: boolean }>) {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), raw = Buffer.from(entry.text), data = entry.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(entry.deflate ? 8 : 0, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function valid() { return { scenarioId: "steering.queue-follow-up", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
  state: { task: { id: "website", identifier: "PAP-7" }, worker: { id: "morgan" }, workerStatusAtReply: "running", canonicalRunId: "controller",
    queuedAtReply: { issueId: "website", state: "queued", entries: [{ position: 0, comment: { id: "contact", body: "Add a contact section", authorAgentId: "ceo", createdByRunId: "controller" } }] },
    queryReply: "I saved the contact request on [PAP-7](/PAP/issues/PAP-7) for Morgan's next turn.", consumedCommentId: "contact", deliveryNativeInputBound: true,
    consumingRunCount: 1, queueEmptyAfterDelivery: true, initialBriefRevisionRetained: true, contactResultRevision: true },
  agents: [], tasks: [{ id: "website", assigneeAgentId: "morgan", status: "done" }], links: [], activity: [], reply: "", humanQueries: [],
  runs: [{ id: "prior", agentId: "morgan", status: "succeeded" }, { id: "controller", agentId: "ceo", status: "succeeded" }, { id: "successor", agentId: "morgan", status: "succeeded" }] }; }
it("accepts actual ordered queue admission and one later consuming native turn", () => expect(gradeQueuedFollowup(valid()).passed).toBe(true));
it("accepts a reworded reply that names the task without queue vocabulary", () => { const o = valid(); o.state.queryReply = "Morgan is mid-turn on PAP-7. Your contact section will reach him once he finishes."; expect(gradeQueuedFollowup(o).passed).toBe(true); });
it("accepts a requirement worded without the word contact", () => { const o = valid(); o.state.queuedAtReply.entries[0]!.comment.body = "Please add a way for visitors to reach us."; expect(gradeQueuedFollowup(o).passed).toBe(true); });
it("rejects absent queue evidence", () => expect(gradeQueuedFollowup(undefined).passed).toBe(false));
it("rejects forwarding to a similarly named task", () => { const o = valid(); o.state.queuedAtReply.issueId = "other"; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a reply that does not identify the affected task", () => { const o = valid(); o.state.queryReply = "Done, I passed it along."; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a different identifier that shares the prefix", () => { const o = valid(); o.state.queryReply = "Saved on PAP-70."; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a requirement written by someone other than the canonical controller turn", () => { const o = valid(); o.state.queuedAtReply.entries[0]!.comment.createdByRunId = "other-run"; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects a successor without the actual saved comment in its native input", () => { const o = valid(); o.state.deliveryNativeInputBound = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects duplicate requirement admission", () => { const o = valid(); o.state.queuedAtReply.entries.push({ ...o.state.queuedAtReply.entries[0]!, position: 1 }); expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects losing the original worker's saved work", () => { const o = valid(); o.state.initialBriefRevisionRetained = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("rejects output attributed to the wrong native revision", () => { const o = valid(); o.state.contactResultRevision = false; expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("accepts the contact section delivered as the successor's registered build instead of a document", () => { const o = valid(); o.state.contactResultRevision = false; Object.assign(o.state, { contactResultDeliverable: true }); expect(gradeQueuedFollowup(o).passed).toBe(true); });
it("rejects a successor deliverable without the contact section", () => { const o = valid(); o.state.contactResultRevision = false; Object.assign(o.state, { contactResultDeliverable: false }); expect(gradeQueuedFollowup(o).passed).toBe(false); });
it("reads stored and deflated zip entries and treats other bytes as no entries", () => {
  const bytes = zip([{ name: "site/index.html", text: '<section id="contact"><h2>Contact</h2></section>', deflate: true }, { name: "site/styles.css", text: "body{margin:0}", deflate: false }]);
  expect(zipEntryTexts(bytes)).toEqual(['<section id="contact"><h2>Contact</h2></section>', "body{margin:0}"]);
  expect(zipEntryTexts(Buffer.from("<html>Contact</html>"))).toEqual([]);
  expect(zipEntryTexts(bytes.subarray(0, bytes.length - 30))).toEqual([]);
});
it("finds the saved comment in a native prompt raw or JSON-escaped, and only with its id and body", () => {
  const comment = { id: "c-1", body: "Add a \"Contact us\" section\nwith email." };
  const prompt = `{"newComments":[{"id":"c-1","body":${JSON.stringify(comment.body)}}]}`;
  expect(promptCarriesComment(prompt, comment)).toBe(true);
  expect(promptCarriesComment(`plain c-1\n${comment.body}`, comment)).toBe(true);
  expect(promptCarriesComment(prompt.replace("c-1", "c-2"), comment)).toBe(false);
  expect(promptCarriesComment("continue the website task c-1", comment)).toBe(false);
  expect(promptCarriesComment(undefined, comment)).toBe(false);
});
it("finds the saved comment when a continuation envelope nests the events JSON as a string", () => {
  const comment = { id: "c-1", body: "Add a \"Contact\" section.\n\n- nav link" };
  const prompt = JSON.stringify({ schema: "paperclip.native-continuation.v1", events: JSON.stringify({ messages: [{ id: "c-1", body: comment.body }, { id: "c-2", body: "Done." }] }) });
  expect(prompt.includes(comment.body) || prompt.includes(JSON.stringify(comment.body).slice(1, -1))).toBe(false);
  expect(promptCarriesComment(prompt, comment)).toBe(true);
  expect(promptCarriesComment(JSON.stringify({ events: JSON.stringify({ messages: [{ id: "c-1", body: "Add a section." }] }) }), comment)).toBe(false);
  expect(promptCarriesComment(JSON.stringify({ events: JSON.stringify({ messages: [{ id: "c-2", body: comment.body }], note: "c-1" }) }), comment)).toBe(false);
});
