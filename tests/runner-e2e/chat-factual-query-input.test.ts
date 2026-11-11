import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
import { uploadFactualQueryAttachment, type ChatQueryAttachmentReceipt } from "./chat-query-attachments.js";
import { buildPaperclipTaskMarkdown } from "../../server/src/services/heartbeat/task-markdown.js";
vi.mock("@playwright/test", () => ({ expect: () => ({ toBeVisible: async () => {}, toContainText: async () => {}, not: { toContainText: async () => {} } }) }));
const id = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const body = "Destination: Synthetic Launch Notes, launch page.\nThe public launch is November 8, 2030.";
  let uploaded: ChatQueryAttachmentReceipt | undefined;
  const state = { patch: {} as Partial<ChatQueryAttachmentReceipt>, changedBytes: false, humanId: "human", deploymentMode: "authenticated", existing: false };
  const inputFile = vi.fn(async (file: { name: string; buffer: Buffer }) => {
    uploaded = { id, companyId: "company", issueId: "source", issueCommentId: null, originalFilename: file.name, contentPath: `/api/attachments/${id}/content`, byteSize: file.buffer.length,
      sha256: createHash("sha256").update(file.buffer).digest("hex"), createdByUserId: "human", createdByAgentId: null, ...state.patch };
  });
  const post = vi.fn(async () => ({})); const evidence = vi.fn(async () => undefined);
  const page = { goto: vi.fn(async () => undefined), getByTestId: () => ({}), locator: () => ({ first: () => ({ setInputFiles: inputFile }) }) };
  const api = { baseURL: "http://fixture.test", post,
    get: vi.fn(async (path: string) => path === "/api/health" ? { deploymentMode: state.deploymentMode } : path === "/api/auth/get-session" ? { user: state.humanId ? { id: state.humanId } : undefined }
      : uploaded ? [uploaded] : state.existing ? [{ originalFilename: "launch-update.md" }] : []),
    getAttachmentContent: vi.fn(async () => Buffer.from(state.changedBytes ? "Different launch data" : body)) };
  const ctx = { scenario: { id: "app-permissions.ask-before-action" }, input: { api, page, evidence, fixtures: { company: { id: "company", issuePrefix: "RUN" }, agent: { id: "ceo" } } },
    refreshIssue: vi.fn(async () => undefined), issue: () => ({ id: "source" }) } as unknown as ChatCatalogContext;
  return { ctx, state, body, inputFile, evidence, post, page };
}
describe("genuine factual canonical query input", () => {
  it("uses the production native context's wake attachment descriptor while conversation descriptions remain suppressed", () => {
    const hiddenDescription = "This incidental chat description is not the person's current input.";
    const markdown = buildPaperclipTaskMarkdown({ issue: { id: "source", identifier: "RUN-1", title: "Chat with CEO", conversationAgentId: "ceo", description: hiddenDescription },
      nativeRunner: true, wakeComments: [{ id: "canonical", body: "Original canonical request\n\n[launch-update.md](/api/attachments/" + id + "/content)",
        attachments: [{ id, filename: "launch-update.md", contentType: "text/markdown", byteSize: 100, contentPath: `/api/attachments/${id}/content` }] }] });
    expect(markdown).not.toContain(hiddenDescription);
    expect(markdown).toContain('Attachments on wake comment "canonical"');
    expect(markdown).toContain('"id":"' + id + '"');
    expect(markdown).toContain('"filename":"launch-update.md"');
    expect(markdown).toContain("Original canonical request");
  });
  it("uploads actual draft facts with independently read bytes and human/source identity without sending a comment", async () => {
    const f = fixture(); const receipt = await uploadFactualQueryAttachment(f.ctx, { filename: "launch-update.md", body: f.body });
    expect(receipt).toMatchObject({ id, createdByUserId: "human", issueId: "source", issueCommentId: null });
    expect(f.inputFile.mock.calls[0]![0].buffer.toString("utf8")).toBe(f.body);
    expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/companies/company/chats/ceo");
    expect(f.page.goto).toHaveBeenCalledExactlyOnceWith("http://fixture.test/RUN/chats/ceo", { waitUntil: "domcontentloaded" });
    expect(f.evidence).toHaveBeenCalledWith("chat-catalog-factual-query-input.json", expect.objectContaining({ body: f.body }));
    expect(f.body).not.toMatch(/approval|ask.first|call_api|execute|expected|tool/);
  });
  it.each(["company", "source", "human", "agent", "bytes", "bound-comment"]) ("rejects plausible wrong %s upload provenance", async kind => {
    const f = fixture();
    if (kind === "company") f.state.patch.companyId = "foreign";
    if (kind === "source") f.state.patch.issueId = "different-source";
    if (kind === "human") f.state.patch.createdByUserId = "other-human";
    if (kind === "agent") f.state.patch.createdByAgentId = "agent";
    if (kind === "bytes") f.state.changedBytes = true;
    if (kind === "bound-comment") f.state.patch.issueCommentId = "pre-existing-comment";
    await expect(uploadFactualQueryAttachment(f.ctx, { filename: "launch-update.md", body: f.body })).rejects.toThrow("bytes/source/human");
    expect(f.evidence).not.toHaveBeenCalled();
  });
  it("rejects trusted-local/fake-user input and duplicate pre-existing context", async () => {
    const noPerson = fixture(); noPerson.state.humanId = "";
    await expect(uploadFactualQueryAttachment(noPerson.ctx, { filename: "launch-update.md", body: noPerson.body })).rejects.toThrow("real authenticated human");
    expect(noPerson.inputFile).not.toHaveBeenCalled();
    const implicit = fixture(); implicit.state.deploymentMode = "local_trusted";
    await expect(uploadFactualQueryAttachment(implicit.ctx, { filename: "launch-update.md", body: implicit.body })).rejects.toThrow("real authenticated human");
    expect(implicit.inputFile).not.toHaveBeenCalled();
    const duplicate = fixture(); duplicate.state.existing = true;
    await expect(uploadFactualQueryAttachment(duplicate.ctx, { filename: "launch-update.md", body: duplicate.body })).rejects.toThrow("already exists");
  });
  it("does not authorize arbitrary cases or wrong file identities", async () => {
    const f = fixture();
    await expect(uploadFactualQueryAttachment(f.ctx, { filename: "selected-source.md", body: f.body })).rejects.toThrow("Undeclared");
    f.ctx.scenario.id = "documents-artifacts.find-artifact";
    await expect(uploadFactualQueryAttachment(f.ctx, { filename: "launch-update.md", body: f.body })).rejects.toThrow("Undeclared");
    expect(f.post).not.toHaveBeenCalled();
  });
});
