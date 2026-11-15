import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { InternalObservation } from "./internal-support.js";
import { projectWorkCases } from "./internal-task-creation.js";

const observed = vi.hoisted(() => ({ value: {} as InternalObservation }));
vi.mock("./internal-support.js", async importOriginal => ({
  ...await importOriginal<typeof import("./internal-support.js")>(),
  observeInternal: async () => observed.value,
}));
beforeEach(() => {
  observed.value = { scenarioId: "projects.project-work", origin: "http://127.0.0.1:3100", companyId: "company", leadId: "ceo",
    state: {}, tasks: [{ id: "work", companyId: "company" }], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [],
    reply: "", links: [], humanQueries: [], runs: [] };
});
function fixture(body: Buffer, byteSize = body.length) {
  const attachmentId = "11111111-1111-4111-8111-111111111111";
  const privateRead = vi.fn(async () => body);
  const rawRead = vi.fn(() => { throw new Error("Unauthenticated transport must not be used"); });
  const ctx = { issue: () => ({ id: "source" }), input: { api: {
    request: { get: rawRead }, getAttachmentContent: privateRead,
    get: vi.fn(async (path: string) => {
      if (path === "/api/issues/source/comments?order=asc") return [];
      if (path === "/api/issues/work/attachments") return [{ id: attachmentId, issueId: "work", originalFilename: "page.html", byteSize }];
      throw new Error("Unexpected observation endpoint");
    }),
  } } } as unknown as ChatCatalogContext;
  return { ctx, privateRead, rawRead, attachmentId };
}
it("downloads actual delivered HTML with the authenticated actor's attachment reader", async () => {
  const body = Buffer.from("<!doctype html><html><body><h1>Actual mobile layout</h1></body></html>");
  const f = fixture(body);
  const result = await projectWorkCases[0]!.observe(f.ctx, {}) as { websiteFiles: unknown[] };
  expect(f.privateRead).toHaveBeenCalledExactlyOnceWith(f.attachmentId);
  expect(f.rawRead).not.toHaveBeenCalled();
  expect(result.websiteFiles).toEqual([{ issueId: "work", attachmentId: f.attachmentId, body: body.toString("utf8"),
    sha256: createHash("sha256").update(body).digest("hex"), createdAt: undefined }]);
});
it("retains metadata and actual-content size bounds and does not rescue a rejected authenticated read", async () => {
  const metadataOversize = fixture(Buffer.from("small"), 1_048_577);
  expect((await projectWorkCases[0]!.observe(metadataOversize.ctx, {}) as { websiteFiles: unknown[] }).websiteFiles).toEqual([]);
  expect(metadataOversize.privateRead).not.toHaveBeenCalled();
  const actualOversize = fixture(Buffer.alloc(1_048_577, 65), 5);
  expect((await projectWorkCases[0]!.observe(actualOversize.ctx, {}) as { websiteFiles: unknown[] }).websiteFiles).toEqual([]);
  const denied = fixture(Buffer.from("irrelevant"));
  denied.privateRead.mockRejectedValue(new Error("Authenticated attachment read denied"));
  await expect(projectWorkCases[0]!.observe(denied.ctx, {})).rejects.toThrow("Authenticated attachment read denied");
  expect(denied.rawRead).not.toHaveBeenCalled();
});
