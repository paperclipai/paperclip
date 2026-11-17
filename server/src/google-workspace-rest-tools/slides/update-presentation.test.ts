import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { updatePresentation, updatePresentationRequest } from "./update-presentation.js";

const REVISION = { requiredRevisionId: "rev-deck-1" };

type Edit = { insertText?: { objectId: string; text: string; insertionIndex?: number }; deleteText?: { objectId: string; textRange: { type: "FIXED_RANGE"; startIndex: number; endIndex: number } } };

function applyInOrder(shapes: Record<string, string>, requests: Edit[]): Record<string, string> {
  const result = { ...shapes };
  for (const request of requests) {
    if (request.insertText) {
      const { objectId, text, insertionIndex = 0 } = request.insertText;
      result[objectId] = result[objectId]!.slice(0, insertionIndex) + text + result[objectId]!.slice(insertionIndex);
    } else if (request.deleteText) {
      const { objectId, textRange } = request.deleteText;
      result[objectId] = result[objectId]!.slice(0, textRange.startIndex) + result[objectId]!.slice(textRange.endIndex);
    }
  }
  return result;
}

describe("update_presentation request", () => {
  it("posts the requests unchanged and in order, with the revision the caller read", () => {
    const requests = [
      { createSlide: { objectId: "new-slide", insertionIndex: 1 } },
      { insertText: { objectId: "title-1", text: "Hi", insertionIndex: 0 } },
    ];
    expect(updatePresentationRequest({ presentationId: "deck-1", requests, writeControl: REVISION })).toEqual({
      method: "POST",
      host: "slides.googleapis.com",
      path: "/v1/presentations/deck-1:batchUpdate",
      body: { requests, writeControl: { requiredRevisionId: "rev-deck-1" } },
    });
  });

  it.each([undefined, {}])("refuses a call without the revision it read: %j", (writeControl) => {
    expect(() => updatePresentationRequest({ presentationId: "d", requests: [{ deleteObject: { objectId: "x" } }], writeControl })).toThrow(/writeControl\.requiredRevisionId is required/);
  });
});

describe("update_presentation edit order", () => {
  const read = { title: "Plan", body: "Ship it" };
  const fromOneRead: Edit[] = [
    { insertText: { objectId: "body", text: " today", insertionIndex: 7 } },
    { deleteText: { objectId: "body", textRange: { type: "FIXED_RANGE", startIndex: 4, endIndex: 5 } } },
    { insertText: { objectId: "body", text: "We ", insertionIndex: 0 } },
    { insertText: { objectId: "title", text: "Q4 ", insertionIndex: 0 } },
  ];

  it("applies edits in one shape correctly from the highest index to the lowest, as the description says", () => {
    expect(applyInOrder(read, fromOneRead)).toEqual({ title: "Q4 Plan", body: "We Shipit today" });
    expect(applyInOrder(read, [...fromOneRead].reverse())).not.toEqual({ title: "Q4 Plan", body: "We Shipit today" });
  });

  it("sends several edits in one call, exactly in the caller's order, and returns the replies and new revision", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ presentationId: "d", replies: [{}, {}, {}, {}], writeControl: { requiredRevisionId: "rev-deck-2" } }));
    const result = await updatePresentation.call({ presentationId: "d", requests: fromOneRead, writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { requests: Edit[] }).requests).toEqual(fromOneRead);
    expect(result.structuredContent).toEqual({ replies: [{}, {}, {}, {}], writeControl: { requiredRevisionId: "rev-deck-2" } });
  });
});

describe("update_presentation tool", () => {
  it("returns a clear error and changes nothing when the presentation changed since it was read", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 400, status: "FAILED_PRECONDITION", message: "The required revision ID 'rev-deck-1' doesn't match the latest revision ID." } }, 400));
    const result = await updatePresentation.call({ presentationId: "d", requests: [{ deleteObject: { objectId: "x" } }], writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "The presentation is no longer at the revision you read (or that revision ID is not valid), so nothing was changed. Read it again with read_presentation and retry with its new revisionId." }],
    });
  });

  it("never retries the write after a timeout-like failure and warns that it may have happened", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 502 } }, 502));
    const result = await updatePresentation.call({ presentationId: "d", requests: [{ deleteObject: { objectId: "x" } }], writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls).toHaveLength(1);
    expect((result.content[0] as { text: string }).text).toMatch(/may or may not have been made/);
  });

  it("recognizes a conflict from Google's structured status", async () => {
    const { fetch } = fakeGoogle(() => json({ error: { code: 400, status: "FAILED_PRECONDITION", message: "Precondition check failed." } }, 400));
    const result = await updatePresentation.call({ presentationId: "d", requests: [{ deleteObject: { objectId: "x" } }], writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.content[0] as { text: string }).text).toMatch(/^The presentation is no longer at the revision you read/);
  });

  it.each([
    ["no requests", { presentationId: "d", writeControl: REVISION }],
    ["an empty request list", { presentationId: "d", requests: [], writeControl: REVISION }],
    ["a request with two kinds", { presentationId: "d", requests: [{ createSlide: {}, deleteObject: {} }], writeControl: REVISION }],
    ["a bad presentation ID", { presentationId: "d/../x", requests: [{ createSlide: {} }], writeControl: REVISION }],
    ["no revision", { presentationId: "d", requests: [{ createSlide: {} }] }],
    ["an empty revision", { presentationId: "d", requests: [{ createSlide: {} }], writeControl: { requiredRevisionId: "" } }],
  ])("sends nothing for %s", async (_name, input) => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    expect((await updatePresentation.call(input, createGoogleHttp({ accessToken: "t", fetch }))).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
