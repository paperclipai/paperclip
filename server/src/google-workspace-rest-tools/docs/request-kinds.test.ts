import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { DOCS_REQUEST_KINDS } from "./request-kinds.js";
import { updateDoc } from "./update-doc.js";

const REVISION = { requiredRevisionId: "rev-1" };
const rules = Object.entries(DOCS_REQUEST_KINDS);
const allowed = rules.flatMap(([kind, rule]) => (rule.allowed ? [[kind, rule.example ?? {}] as const] : []));
const refused = rules.flatMap(([kind, rule]) => (rule.allowed ? [] : [[kind, rule.reason] as const]));

async function send(requests: Array<Record<string, unknown>>) {
  const { fetch, calls } = fakeGoogle(() => json({ replies: requests.map(() => ({})), writeControl: { requiredRevisionId: "rev-2" } }));
  const result = await updateDoc.call({ documentId: "d", requests, writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
  return { result, calls, text: (result.content[0] as { text: string }).text };
}

describe("update_doc request kinds", () => {
  it("covers every request kind in Google's documents.batchUpdate reference, each either allowed or refused", () => {
    expect(rules.map(([kind]) => kind).sort()).toEqual([
      "acceptSuggestion", "addCommentReply", "addDocumentTab", "createDropdownDefinition", "createFooter", "createFootnote", "createHeader",
      "createNamedRange", "createParagraphBullets", "deleteComment", "deleteCommentReply", "deleteContentRange", "deleteDropdownDefinition",
      "deleteFooter", "deleteHeader", "deleteNamedRange", "deleteParagraphBullets", "deletePositionedObject", "deleteSuggestion", "deleteTab",
      "deleteTableColumn", "deleteTableRow", "insertComment", "insertDate", "insertDropdown", "insertInlineImage", "insertPageBreak", "insertPerson",
      "insertRichLink", "insertSectionBreak", "insertTable", "insertTableColumn", "insertTableRow", "insertText", "mergeTableCells",
      "pinTableHeaderRows", "rejectSuggestion", "replaceAllText", "replaceImage", "replaceNamedRangeContent", "unmergeTableCells",
      "updateCommentPost", "updateDocumentStyle", "updateDocumentTabProperties", "updateDropdownDefinitionProperties", "updateDropdownProperties",
      "updateNamedStyle", "updateParagraphStyle", "updateSectionStyle", "updateTableCellStyle", "updateTableColumnProperties",
      "updateTableRowStyle", "updateTextStyle",
    ]);
  });

  it.each(allowed)("passes %s through unchanged", async (kind, body) => {
    const request = { [kind]: body };
    const { result, calls } = await send([request]);
    expect(result.isError).toBeUndefined();
    expect((calls[0]!.body as { requests: unknown[] }).requests).toEqual([request]);
  });

  it.each(refused)("refuses %s and sends nothing", async (kind, reason) => {
    const { result, calls, text } = await send([{ insertText: { text: "a", location: { index: 1 } } }, { [kind]: {} }]);
    expect(result.isError).toBe(true);
    expect(text).toBe(`requests[1].${kind} ${reason} This tool only changes the one file it is given, so nothing was changed.`);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["insertInlineImage", { uri: "https://drive.google.com/uc?id=file-1", location: { index: 1 } }, "uri"],
    ["replaceImage", { imageObjectId: "kix.img1", uri: "https://docs.google.com/drawings/d/x/export/png" }, "uri"],
  ])("refuses %s with a picture from another Google file, and sends nothing", async (kind, body, field) => {
    const { calls, text } = await send([{ [kind]: body }]);
    expect(text).toContain(`requests[0].${kind} takes its picture from a Google Drive or Docs link (${field}), which is another file.`);
    expect(calls).toHaveLength(0);
  });

  it.each(["copyDocument", "deleteDocument", "insertAudio", "futureRequestKind"])("refuses the unknown kind %s and sends nothing", async (kind) => {
    const { calls, text } = await send([{ [kind]: {} }]);
    expect(text).toBe(`requests[0].${kind} is not a request kind this tool accepts. This tool only changes the one file it is given, so nothing was changed.`);
    expect(calls).toHaveLength(0);
  });

  it("lists the accepted and refused kinds in the tool description from the same table", () => {
    const description = updateDoc.definition.description!;
    for (const [kind] of allowed) expect(description).toContain(kind);
    expect(description).toContain(`Refused because they read another file: ${refused.map(([kind]) => kind).join(", ")}.`);
  });
});
