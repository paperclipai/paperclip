import { describe, expect, it } from "vitest";
import { FALLBACK_MAX_RESULT_BYTES } from "../tool.js";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { DECK, DECK_TEXT, shape, slide } from "./fixtures/slides-rest.js";
import { readPresentation, readPresentationRequest } from "./read-presentation.js";

describe("read_presentation request", () => {
  it.each([
    [{ presentationId: "deck-1" }, {}],
    [{ presentationId: "deck-1", commentsIncluded: true }, { commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED" }],
    [{ presentationId: "deck-1", fields: ["revisionId", "slides(objectId,pageElements(objectId,shape.text))"] }, { fields: "revisionId,slides(objectId,pageElements(objectId,shape.text))" }],
    [{ presentationId: "deck-1", fields: [] }, {}],
  ])("reads %j", (input, query) => {
    const request = readPresentationRequest(input);
    expect(request).toMatchObject({ method: "GET", host: "slides.googleapis.com", path: "/v1/presentations/deck-1" });
    expect(Object.fromEntries(Object.entries(request.query ?? {}).filter(([, value]) => value !== undefined))).toEqual(query);
  });
});

describe("read_presentation tool", () => {
  it("returns the text form, structure and revision without fields", async () => {
    const { fetch, calls } = fakeGoogle(() => json(DECK));
    const result = await readPresentation.call({ presentationId: "deck-synthetic-1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.host}${call.url.pathname}${call.url.search}`)).toEqual(["GET slides.googleapis.com/v1/presentations/deck-synthetic-1"]);
    expect((result.structuredContent as { content: Record<string, unknown> }).content).toMatchObject({ revisionId: "rev-deck-1", text: DECK_TEXT });
  });

  it("returns Google's answer unchanged when fields are given", async () => {
    const partial = { revisionId: "rev-deck-1", slides: [{ objectId: "s1" }] };
    const { fetch, calls } = fakeGoogle(() => json(partial));
    const result = await readPresentation.call({ presentationId: "deck-1", fields: ["revisionId", "slides.objectId"] }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[0]!.url.searchParams.get("fields")).toBe("revisionId,slides.objectId");
    expect(result.structuredContent).toEqual({ content: partial });
  });

  it("refuses malformed IDs and field masks without calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const http = createGoogleHttp({ accessToken: "t", fetch });
    for (const input of [
      { presentationId: "../x" },
      { presentationId: "a/b" },
      { presentationId: "deck", fields: ["slides&key=x"] },
      { presentationId: "deck", fields: ["slides objectId"] },
      { presentationId: "deck", fields: [""] },
      { presentationId: "deck", fields: "slides" },
    ]) {
      expect((await readPresentation.call(input, http)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("says when comments are not available with the user's access, after checking the presentation itself can be read", async () => {
    const { fetch, calls } = fakeGoogle(({ url }) => (url.searchParams.get("fields") === "presentationId"
      ? json({ presentationId: "deck-1" })
      : json({ error: { code: 403, status: "PERMISSION_DENIED", message: "The caller does not have permission" } }, 403)));
    const result = await readPresentation.call({ presentationId: "deck-1", commentsIncluded: true }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((result.content[0] as { text: string }).text).toBe("Comments are not available for this presentation with your access, so nothing was returned. The presentation can be read without them: call read_presentation again without commentsIncluded.");
    expect(calls.map((call) => call.url.search)).toEqual(["?commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED", "?fields=presentationId"]);
  });

  it("refuses a result over the size limit and suggests fields", async () => {
    const line = "y".repeat(10_000);
    const big = { presentationId: "big", slides: Array.from({ length: Math.ceil(FALLBACK_MAX_RESULT_BYTES / 20_000) + 5 }, (_, index) => slide(`s${index}`, [shape(`e${index}`, [{ text: line }])])) };
    const { fetch } = fakeGoogle(() => json(big));
    const result = await readPresentation.call({ presentationId: "big" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^The result is [\d,]+ bytes, more than the 250,000 bytes this tool can return, so it was not returned\. Pass fields to read only part of it/);
    const fields = await readPresentation.call({ presentationId: "big", fields: ["slides"] }, createGoogleHttp({ accessToken: "t", fetch }));
    expect((fields.content[0] as { text: string }).text).toMatch(/so it was not returned\. Ask for fewer fields\.$/);
  });
});
