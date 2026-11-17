import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { SLIDES_REQUEST_KINDS } from "./request-kinds.js";
import { updatePresentation } from "./update-presentation.js";

const REVISION = { requiredRevisionId: "rev-1" };
const rules = Object.entries(SLIDES_REQUEST_KINDS);
const allowed = rules.flatMap(([kind, rule]) => (rule.allowed ? [[kind, rule.example ?? {}] as const] : []));
const refused = rules.flatMap(([kind, rule]) => (rule.allowed ? [] : [[kind, rule.reason] as const]));

async function send(requests: Array<Record<string, unknown>>) {
  const { fetch, calls } = fakeGoogle(() => json({ replies: requests.map(() => ({})), writeControl: { requiredRevisionId: "rev-2" } }));
  const result = await updatePresentation.call({ presentationId: "p", requests, writeControl: REVISION }, createGoogleHttp({ accessToken: "t", fetch }));
  return { result, calls, text: (result.content[0] as { text: string }).text };
}

describe("update_presentation request kinds", () => {
  it("covers every request kind in Google's presentations.batchUpdate reference plus the MCP tool's importSlides and createAudio", () => {
    expect(rules.map(([kind]) => kind).sort()).toEqual([
      "addCommentReply", "createAudio", "createImage", "createLine", "createParagraphBullets", "createShape", "createSheetsChart", "createSlide",
      "createTable", "createVideo", "deleteComment", "deleteCommentReply", "deleteObject", "deleteParagraphBullets", "deleteTableColumn",
      "deleteTableRow", "deleteText", "duplicateObject", "groupObjects", "importSlides", "insertComment", "insertTableColumns", "insertTableRows",
      "insertText", "mergeTableCells", "refreshSheetsChart", "replaceAllShapesWithImage", "replaceAllShapesWithSheetsChart", "replaceAllText",
      "replaceImage", "rerouteLine", "ungroupObjects", "unmergeTableCells", "updateCommentPost", "updateImageProperties", "updateLineCategory",
      "updateLineProperties", "updatePageElementAltText", "updatePageElementTransform", "updatePageElementsZOrder", "updatePageProperties",
      "updateParagraphStyle", "updateShapeProperties", "updateSlideProperties", "updateSlidesPosition", "updateTableBorderProperties",
      "updateTableCellProperties", "updateTableColumnProperties", "updateTableRowProperties", "updateTextStyle", "updateVideoProperties",
    ]);
  });

  it.each(allowed)("passes %s through unchanged", async (kind, body) => {
    const request = { [kind]: body };
    const { result, calls } = await send([request]);
    expect(result.isError).toBeUndefined();
    expect((calls[0]!.body as { requests: unknown[] }).requests).toEqual([request]);
  });

  it.each(refused)("refuses %s and sends nothing", async (kind, reason) => {
    const { result, calls, text } = await send([{ insertText: { objectId: "a", text: "x" } }, { [kind]: {} }]);
    expect(result.isError).toBe(true);
    expect(text).toBe(`requests[1].${kind} ${reason} This tool only changes the one file it is given, so nothing was changed.`);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["createVideo", { source: "DRIVE", id: "file-1" }, "is accepted only with source YOUTUBE; a DRIVE video is another file."],
    ["createVideo", { id: "file-1" }, "is accepted only with source YOUTUBE; a DRIVE video is another file."],
    ["createImage", { url: "https://drive.google.com/uc?id=file-1" }, "takes its picture from a Google Drive or Docs link (url), which is another file."],
    ["replaceImage", { imageObjectId: "i", url: "https://docs.google.com/drawings/d/x/export/png" }, "takes its picture from a Google Drive or Docs link (url), which is another file."],
    ["replaceAllShapesWithImage", { imageUrl: "https://drive.google.com/uc?id=f" }, "takes its picture from a Google Drive or Docs link (imageUrl), which is another file."],
    ["updatePageProperties", { objectId: "s1", pageProperties: { pageBackgroundFill: { stretchedPictureFill: { contentUrl: "https://drive.google.com/uc?id=f" } } }, fields: "pageBackgroundFill" }, "takes its picture from a Google Drive or Docs link (pageProperties.pageBackgroundFill.stretchedPictureFill.contentUrl), which is another file."],
  ])("refuses %s in a form that reads another file (%j), and sends nothing", async (kind, body, reason) => {
    const { calls, text } = await send([{ [kind]: body }]);
    expect(text).toBe(`requests[0].${kind} ${reason} This tool only changes the one file it is given, so nothing was changed.`);
    expect(calls).toHaveLength(0);
  });

  it.each(["updateAudioProperties", "createPresentation", "futureRequestKind"])("refuses the unknown kind %s and sends nothing", async (kind) => {
    const { calls, text } = await send([{ [kind]: {} }]);
    expect(text).toBe(`requests[0].${kind} is not a request kind this tool accepts. This tool only changes the one file it is given, so nothing was changed.`);
    expect(calls).toHaveLength(0);
  });

  it("lists the accepted and refused kinds in the tool description from the same table", () => {
    const description = updatePresentation.definition.description!;
    for (const [kind] of allowed) expect(description).toContain(kind);
    expect(description).toContain(`Refused because they read another file: ${refused.map(([kind]) => kind).join(", ")}.`);
  });
});
