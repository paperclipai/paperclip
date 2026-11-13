import { describe, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { IssueAttachment } from "../../../packages/shared/src/types/issue.js";
import { selectDocumentSource } from "./internal-document-context.js";
import { uploadFactualQueryAttachment } from "../chat-query-attachments.js";
vi.mock("../chat-query-attachments.js", () => ({ uploadFactualQueryAttachment: vi.fn(async () => ({ id: "factual-upload" })) }));

function fixture() {
  const target = { id: "target", companyId: "company", projectId: "project", identifier: "RUN-1", title: "Website task" };
  const source = { id: "chat", companyId: "company", projectId: null as string | null, description: null as string | null };
  const document = { id: "doc", issueId: "target", key: "plan", title: "Implementation plan", latestRevisionId: "revision", body: "Original pricing bytes" };
  const annotation = { id: "comment", documentId: "doc", originalRevisionId: "revision", status: "open" };
  const attachment = { id: "file", issueId: "target", sha256: "original-hash", originalFilename: "website-v1.html", contentPath: "/api/attachments/file/content" } as IssueAttachment;
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === "/api/issues/target") return structuredClone(target);
      if (path === "/api/issues/chat") return structuredClone(source);
      if (path.endsWith("/annotations?status=all&includeComments=true")) return [structuredClone(annotation)];
      if (path.endsWith("/documents/plan")) return structuredClone(document);
      if (path.endsWith("/attachments")) return [structuredClone(attachment)];
      throw new Error(`Unexpected read ${path}`);
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async (_path: string, value: object) => Object.assign(source, value)),
  };
  const evidence = vi.fn(async () => undefined);
  const ctx = { input: { api, fixtures: { company: { id: "company", issuePrefix: "RUN" }, agent: { id: "ceo" } }, evidence },
    refreshIssue: vi.fn(async () => undefined), issue: () => source } as unknown as ChatCatalogContext;
  return { ctx, target, source, document, annotation, attachment, api, evidence };
}

describe("factual visible document source selection", () => {
  it("persists the selected task/document/comment on the real chat without copying an answer or editing the target", async () => {
    const f = fixture(); const original = structuredClone({ document: f.document, annotation: f.annotation });
    const receipt = await selectDocumentSource(f.ctx, { task: f.target, document: f.document, annotationId: f.annotation.id });
    expect(f.source.description).toBe("Selected source: [Website task](/RUN/issues/RUN-1).\n\nSelected document: [Implementation plan](/RUN/issues/RUN-1#document-plan).\n\nSelected review comment: comment on this document.");
    expect(receipt.targetIssueId).toBe("target");
    expect(uploadFactualQueryAttachment).toHaveBeenLastCalledWith(f.ctx, { filename: "selected-source.md", body: f.source.description });
    expect(receipt.factualContextAttachment.id).toBe("factual-upload");
    expect({ document: f.document, annotation: f.annotation }).toEqual(original);
    expect(f.api.patch).toHaveBeenCalledExactlyOnceWith("/api/issues/chat", { projectId: "project", description: f.source.description });
    expect(f.api.post).toHaveBeenCalledExactlyOnceWith("/api/companies/company/chats/ceo");
    expect(f.evidence).toHaveBeenCalledOnce();
  });
  it("selects an existing revision without supplying which historical contents to restore", async () => {
    const f = fixture(); await selectDocumentSource(f.ctx, { task: f.target, document: f.document });
    expect(f.source.description).toContain("#document-plan");
    expect(f.source.description).not.toMatch(/pricing|revision|restore|previous|Original/);
  });
  it("selects the actual original delivery and preserves its original bytes", async () => {
    const f = fixture(); await selectDocumentSource(f.ctx, { task: f.target, attachment: f.attachment });
    expect(f.source.description).toContain("[website-v1.html](/api/attachments/file/content)");
    expect(f.source.description).not.toMatch(/headline|shorten|new version/);
    expect(f.api.patch.mock.calls.every(([path]) => path === "/api/issues/chat")).toBe(true);
  });
  it("names the generated workspace source without pre-registering the requested delivery", async () => {
    const f = fixture(); await selectDocumentSource(f.ctx, { task: f.target, workspaceFilename: "website.html" });
    expect(f.source.description).toContain("Selected workspace file: website.html");
    expect(f.source.description).not.toMatch(/attachments|download|upload|register/);
    expect(f.api.post).toHaveBeenCalledOnce();
  });
  it.each(["company", "project", "revision", "annotation", "attachment", "persist"]) ("rejects plausible wrong %s evidence before the canonical turn", async kind => {
    const f = fixture(); const input = { task: structuredClone(f.target), document: { ...f.document }, annotationId: "comment", attachment: { ...f.attachment } };
    if (kind === "company") f.target.companyId = "foreign";
    if (kind === "project") f.target.projectId = "other-project";
    if (kind === "revision") f.document.latestRevisionId = "other-revision";
    if (kind === "annotation") f.annotation.documentId = "other-doc";
    if (kind === "attachment") f.attachment.sha256 = "different-bytes";
    if (kind === "persist") f.api.patch.mockImplementation(async () => f.source);
    await expect(selectDocumentSource(f.ctx, input)).rejects.toThrow();
    expect(f.evidence).not.toHaveBeenCalled();
  });
});
