import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { updateDoc, updateDocRequest } from "./update-doc.js";

const REVISION = { requiredRevisionId: "rev-7" };

type Edit = { insertText?: { text: string; location: { index: number } }; deleteContentRange?: { range: { startIndex: number; endIndex: number } } };

function applyInOrder(body: string, requests: Edit[]): string {
  let current = body;
  for (const request of requests) {
    if (request.insertText) {
      const at = request.insertText.location.index - 1;
      current = current.slice(0, at) + request.insertText.text + current.slice(at);
    } else if (request.deleteContentRange) {
      const { startIndex, endIndex } = request.deleteContentRange.range;
      current = current.slice(0, startIndex - 1) + current.slice(endIndex - 1);
    }
  }
  return current;
}

function body(call: { body: unknown }): { requests: Edit[]; writeControl: Record<string, unknown> } {
  return call.body as { requests: Edit[]; writeControl: Record<string, unknown> };
}

describe("update_doc request", () => {
  it("posts the requests unchanged and in order, with the revision the caller read", () => {
    const requests = [
      { insertText: { text: "!", location: { index: 12 } } },
      { updateTextStyle: { range: { startIndex: 1, endIndex: 6 }, textStyle: { bold: true }, fields: "bold" } },
      { replaceAllText: { containsText: { text: "draft", matchCase: true }, replaceText: "final" } },
    ];
    expect(updateDocRequest({ documentId: "doc-1", requests, writeControl: REVISION })).toEqual({
      method: "POST",
      host: "docs.googleapis.com",
      path: "/v1/documents/doc-1:batchUpdate",
      body: { requests, writeControl: { requiredRevisionId: "rev-7" } },
    });
  });

  it.each(["EDIT", "SUGGEST", "WRITE_MODE_UNSPECIFIED"] as const)("passes writeMode %s through", (writeMode) => {
    const request = updateDocRequest({ documentId: "d", requests: [{ insertText: { text: "a", location: { index: 1 } } }], writeControl: { ...REVISION, writeMode } });
    expect((request.body as { writeControl: unknown }).writeControl).toEqual({ requiredRevisionId: "rev-7", writeMode });
  });

  it.each([
    ["no writeControl", undefined, /writeControl\.requiredRevisionId is required/],
    ["an empty writeControl", {}, /writeControl\.requiredRevisionId is required/],
    ["only a write mode", { writeMode: "EDIT" as const }, /writeControl\.requiredRevisionId is required/],
    ["targetRevisionId", { targetRevisionId: "rev-7" }, /targetRevisionId is not supported/],
    ["both revision fields", { requiredRevisionId: "rev-7", targetRevisionId: "rev-7" }, /targetRevisionId is not supported/],
  ])("refuses %s", (_name, writeControl, message) => {
    expect(() => updateDocRequest({ documentId: "d", requests: [{ insertText: { text: "a", location: { index: 1 } } }], writeControl })).toThrow(message);
  });
});

describe("update_doc edit order", () => {
  const read = "Hello world.";
  const fromOneRead: Edit[] = [
    { insertText: { text: " and goodbye", location: { index: 12 } } },
    { deleteContentRange: { range: { startIndex: 7, endIndex: 8 } } },
    { insertText: { text: "Well, ", location: { index: 1 } } },
  ];

  it("applies edits made from one read correctly when they go from the highest index to the lowest, as the description says", () => {
    expect(applyInOrder(read, fromOneRead)).toBe("Well, Hello orld and goodbye.");
    expect(applyInOrder(read, [...fromOneRead].reverse())).not.toBe("Well, Hello orld and goodbye.");
  });

  it("sends several edits in one call, exactly in the caller's order, in a single request", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ documentId: "d", replies: [{}, {}, {}], writeControl: { requiredRevisionId: "rev-8" } }));
    const result = await updateDoc.call({ documentId: "d", requests: fromOneRead, writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(body(calls[0]!).requests).toEqual(fromOneRead);
    expect(applyInOrder(read, body(calls[0]!).requests)).toBe("Well, Hello orld and goodbye.");
    expect(result.structuredContent).toEqual({ replies: [{}, {}, {}], writeControl: { requiredRevisionId: "rev-8" } });
  });

  it("keeps dependent edits in order: an insertion and then styling of the inserted text", async () => {
    const requests = [
      { insertText: { text: "Title\n", location: { index: 1 } } },
      { updateParagraphStyle: { range: { startIndex: 1, endIndex: 7 }, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } },
    ];
    const { fetch, calls } = fakeGoogle(() => json({ replies: [{}, {}], writeControl: { requiredRevisionId: "rev-8" } }));
    await updateDoc.call({ documentId: "d", requests, writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(body(calls[0]!).requests.map((request) => Object.keys(request)[0])).toEqual(["insertText", "updateParagraphStyle"]);
  });
});

describe("update_doc tool", () => {
  it("returns a clear error and changes nothing when the document changed since it was read", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "The required revision ID 'rev-7' does not match the latest revision." } }, 400));
    const result = await updateDoc.call({ documentId: "d", requests: [{ insertText: { text: "a", location: { index: 1 } } }], writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "The document is no longer at the revision you read (or that revision ID is not valid), so nothing was changed. Read it again with read_doc and retry with its new revisionId." }],
    });
  });

  it.each([
    ["FAILED_PRECONDITION", { code: 400, status: "FAILED_PRECONDITION", message: "Precondition check failed." }, 400],
    ["a revision reason in the details", { code: 400, status: "INVALID_ARGUMENT", message: "Request failed.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "REVISION_MISMATCH" }] }, 400],
    ["ABORTED on 409", { code: 409, status: "ABORTED", message: "Aborted." }, 409],
  ])("recognizes a conflict from Google's structured %s", async (_name, error, status) => {
    const { fetch } = fakeGoogle(() => json({ error }, status));
    const result = await updateDoc.call({ documentId: "d", requests: [{ insertText: { text: "a", location: { index: 1 } } }], writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.content[0] as { text: string }).text).toMatch(/^The document is no longer at the revision you read/);
  });

  it("does not call a 400 that only mentions revisions a conflict", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid requests[0].updateDocumentStyle: revisions of the page size are not allowed." } }, 400));
    const result = await updateDoc.call({ documentId: "d", requests: [{ updateDocumentStyle: {} }], writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.content[0] as { text: string }).text).toBe("Invalid requests[0].updateDocumentStyle: revisions of the page size are not allowed.");
  });

  it("passes other rejections through with Google's message", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 400, message: "Invalid requests[0].insertText: Index 99 must be less than the end index of the referenced segment, 12." } }, 400));
    const result = await updateDoc.call({ documentId: "d", requests: [{ insertText: { text: "a", location: { index: 99 } } }], writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.content[0] as { text: string }).text).toBe("Invalid requests[0].insertText: Index 99 must be less than the end index of the referenced segment, 12.");
  });

  it.each([
    ["a server error", () => json({ error: { code: 503 } }, 503)],
    ["a dropped connection", () => { throw new TypeError("fetch failed"); }],
  ])("never retries the write after %s and warns that it may have happened", async (_name, answer) => {
    const { fetch, calls } = fakeGoogle(answer);
    const result = await updateDoc.call({ documentId: "d", requests: [{ insertText: { text: "a", location: { index: 1 } } }], writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/may or may not have been made/);
  });

  it.each([
    ["no requests", { documentId: "d", writeControl: REVISION }],
    ["an empty request list", { documentId: "d", requests: [], writeControl: REVISION }],
    ["a request with two kinds", { documentId: "d", requests: [{ insertText: {}, deleteContentRange: {} }], writeControl: REVISION }],
    ["a request with no kind", { documentId: "d", requests: [{}], writeControl: REVISION }],
    ["a request that is not an object", { documentId: "d", requests: ["insertText"], writeControl: REVISION }],
    ["a bad document ID", { documentId: "../d", requests: [{ insertText: {} }], writeControl: REVISION }],
    ["no revision", { documentId: "d", requests: [{ insertText: {} }] }],
    ["a target revision", { documentId: "d", requests: [{ insertText: {} }], writeControl: { targetRevisionId: "r" } }],
    ["an unknown write mode", { documentId: "d", requests: [{ insertText: {} }], writeControl: { ...REVISION, writeMode: "FORCE" } }],
    ["too many requests", { documentId: "d", requests: Array.from({ length: 501 }, () => ({ insertText: {} })), writeControl: REVISION }],
  ])("sends nothing for %s", async (_name, input) => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    expect((await updateDoc.call(input, createGoogleHttp({ accessToken: "t", fetch }))).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
