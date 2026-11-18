import { describe, expect, it } from "vitest";
import { oneTab, text } from "./docs/fixtures/docs-rest.js";
import { fakeGoogle, json } from "./fixtures/fake-google.js";
import { shape, slide } from "./slides/fixtures/slides-rest.js";
import { z } from "zod";
import { defineTool, FALLBACK_MAX_RESULT_BYTES, serializedResultBytes } from "./tool.js";
import { callGoogleWorkspaceRestTool, type GoogleWorkspaceRestService } from "./tools.js";
import { READ_LESS } from "./drive/file.js";

interface BudgetCase {
  service: GoogleWorkspaceRestService;
  name: string;
  arguments: (size: number) => Record<string, unknown>;
  answer: (size: number, url: URL) => Response;
  advice: string;
}

const filler = (size: number) => "a".repeat(size);
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");

const CASES: BudgetCase[] = [
  {
    service: "gmail",
    name: "get_message",
    arguments: () => ({ messageId: "msg1" }),
    answer: (size) => json({
      id: "msg1", threadId: "thr1", internalDate: "1763337600000",
      payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Report" }], body: { size, data: b64(filler(size)) } },
    }),
    advice: "Read it with messageFormat METADATA_ONLY or MINIMAL, which leave out the bodies.",
  },
  {
    service: "gmail",
    name: "list_labels",
    arguments: () => ({}),
    answer: (size) => json({ labels: [{ id: "Label_1", name: filler(size), type: "user" }] }),
    advice: "Ask for fewer labels with a smaller pageSize.",
  },
  {
    service: "calendar",
    name: "list_calendars",
    arguments: () => ({}),
    answer: (size) => json({ items: [{ id: "primary", summary: filler(size), timeZone: "UTC" }] }),
    advice: "Ask for fewer calendars with a smaller pageSize.",
  },
  {
    service: "calendar",
    name: "get_event",
    arguments: () => ({ eventId: "evt1" }),
    answer: (size) => json({ id: "evt1", status: "confirmed", summary: "Review", description: filler(size),
      start: { dateTime: "2026-11-18T10:00:00Z" }, end: { dateTime: "2026-11-18T11:00:00Z" } }),
    advice: "This tool cannot return part of an event.",
  },
  {
    service: "drive",
    name: "read_file_content",
    arguments: () => ({ fileId: "text0001synthetic" }),
    answer: (size, url) => url.searchParams.get("alt") === "media"
      ? new Response(filler(size))
      : json({ id: "text0001synthetic", name: "notes.txt", mimeType: "text/plain", size: String(size) }),
    advice: READ_LESS.read,
  },
  {
    service: "docs",
    name: "read_doc",
    arguments: () => ({ documentId: "doc1" }),
    answer: (size) => json(oneTab([text(filler(size))])),
    advice: "This tool cannot read part of a document. Read it without commentsIncluded if that was set, or read only its text with read_file_content.",
  },
  {
    service: "slides",
    name: "read_presentation",
    arguments: () => ({ presentationId: "deck1" }),
    answer: (size) => json({ presentationId: "deck1", revisionId: "r1", slides: [slide("s1", [shape("e1", [{ text: filler(size) }])])] }),
    advice: "Pass fields to read only part of it, for example [\"slides.objectId\", \"slides.pageElements(objectId,shape.text)\"].",
  },
  {
    service: "sheets",
    name: "get_values",
    arguments: () => ({ spreadsheetId: "sheet1", range: "Sheet1!A1" }),
    answer: (size) => json({ range: "Sheet1!A1", majorDimension: "ROWS", values: [[filler(size)]] }),
    advice: "Ask for a narrower range, with fewer rows or columns (for example Sheet1!A1:Z1000), and read the rest in further calls.",
  },
];

function call(testCase: BudgetCase, size: number, maxResultBytes?: number) {
  const { fetch } = fakeGoogle(({ url }) => testCase.answer(size, url));
  return callGoogleWorkspaceRestTool({
    service: testCase.service, name: testCase.name, arguments: testCase.arguments(size), accessToken: "t", fetch,
    ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
  });
}

async function largestThatFits(testCase: BudgetCase, maxResultBytes?: number): Promise<number> {
  let largest = 0;
  for (let step = 1 << 21; step >= 1; step >>= 1) {
    if (!(await call(testCase, largest + step, maxResultBytes)).isError) largest += step;
  }
  return largest;
}

const errorText = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe("result budget", () => {
  it.each(CASES.map((testCase) => [`${testCase.service} ${testCase.name}`, testCase] as const))(
    "%s: returns a result just under the budget it is given and refuses one just over it, saying how to ask for less",
    async (_label, testCase) => {
      const budget = 40_000;
      const largest = await largestThatFits(testCase, budget);
      const fits = await call(testCase, largest, budget);
      expect(fits.isError).toBeUndefined();
      expect(serializedResultBytes(fits)).toBeLessThanOrEqual(budget);
      expect(serializedResultBytes(fits)).toBeGreaterThan(budget - 64);
      const over = await call(testCase, largest + 1, budget);
      expect(over.isError).toBe(true);
      expect(over.structuredContent).toBeUndefined();
      expect(errorText(over)).toMatch(/^The result is [\d,]+ bytes, more than the 40,000 bytes this tool can return, so it was not returned\. /);
      expect(errorText(over).endsWith(testCase.advice)).toBe(true);
    },
  );

  it.each(CASES.map((testCase) => [`${testCase.service} ${testCase.name}`, testCase] as const))(
    "%s: uses the fallback budget only when the caller passes none",
    async (_label, testCase) => {
      const size = 150_000;
      const fallback = await call(testCase, size);
      expect(fallback.isError).toBe(true);
      expect(errorText(fallback)).toMatch(/more than the 250,000 bytes this tool can return/);
      const supplied = await call(testCase, size, 1_000_000);
      expect(supplied.isError).toBeUndefined();
      expect(serializedResultBytes(supplied)).toBeGreaterThan(FALLBACK_MAX_RESULT_BYTES);
    },
  );

  it("never turns a completed write into an error, whatever the size of its result", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ id: "draft1", message: { id: "msg2", threadId: "thr2" } }));
    const body = filler(30_000);
    const result = await callGoogleWorkspaceRestTool({ service: "gmail", name: "create_draft", arguments: { to: ["sam@example.test"], subject: "Report", body },
      accessToken: "t", fetch, maxResultBytes: 1_000 });
    expect(result.isError).toBeUndefined();
    expect(serializedResultBytes(result)).toBeGreaterThan(1_000);
    expect(result.structuredContent).toMatchObject({ id: "draft1", plaintextBody: body });
    expect(calls).toHaveLength(1);
  });

  it("requires advice from every read tool and none from a write tool", () => {
    const definition = (readOnlyHint: boolean) => ({ name: "t", inputSchema: { type: "object" as const }, annotations: { readOnlyHint } });
    const run = async () => ({ content: [] });
    expect(() => defineTool({ definition: definition(true), args: z.object({}), run })).toThrow(/read tool must say how to ask for less/);
    expect(() => defineTool({ definition: definition(false), args: z.object({}), whenTooLarge: "x", run })).toThrow(/write tool must not/);
  });

  it("refuses a budget that is not a positive whole number before calling Google", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ labels: [] }));
    for (const maxResultBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(callGoogleWorkspaceRestTool({ service: "gmail", name: "list_labels", accessToken: "t", fetch, maxResultBytes }))
        .rejects.toThrow(/maxResultBytes must be a positive integer/);
    }
    expect(calls).toHaveLength(0);
  });

  it("caps a Drive download at the budget it is given, not at the fallback", async () => {
    const big = { id: "pdf1", name: "big.pdf", mimeType: "application/pdf", size: String(FALLBACK_MAX_RESULT_BYTES + 1) };
    const { fetch, calls } = fakeGoogle(({ url }) => url.searchParams.get("alt") === "media" ? new Response(new Uint8Array(FALLBACK_MAX_RESULT_BYTES + 1)) : json(big));
    const fallback = await callGoogleWorkspaceRestTool({ service: "drive", name: "download_file_content", arguments: { fileId: "pdf1" }, accessToken: "t", fetch });
    expect(errorText(fallback)).toMatch(/^This file is 250,001 bytes, more than the 250,000 bytes this tool can return/);
    expect(calls).toHaveLength(1);
    const supplied = await callGoogleWorkspaceRestTool({ service: "drive", name: "download_file_content", arguments: { fileId: "pdf1" }, accessToken: "t", fetch, maxResultBytes: 1_000_000 });
    expect(supplied.isError).toBeUndefined();
    expect(Buffer.from((supplied.structuredContent as { content: string }).content, "base64")).toHaveLength(FALLBACK_MAX_RESULT_BYTES + 1);
  });

  it("tells a Gmail list caller to lower the page size", async () => {
    const thread = (id: string) => ({ id, messages: [{ id: `${id}m`, threadId: id, internalDate: "1763337600000", snippet: filler(2_000),
      payload: { headers: [{ name: "Subject", value: filler(2_000) }] } }] });
    const { fetch } = fakeGoogle(({ url }) => url.pathname.endsWith("/threads")
      ? json({ threads: Array.from({ length: 20 }, (_, index) => ({ id: `t${index}` })) })
      : json(thread(url.pathname.split("/").at(-1)!)));
    const result = await callGoogleWorkspaceRestTool({ service: "gmail", name: "search_threads", arguments: { query: "report" }, accessToken: "t", fetch, maxResultBytes: 20_000 });
    expect(errorText(result)).toMatch(/so it was not returned\. Ask for fewer threads with a smaller pageSize, then read single threads with get_thread\.$/);
  });
});
