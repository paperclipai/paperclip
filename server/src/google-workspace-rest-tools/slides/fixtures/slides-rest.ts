import type { RestPage, RestPageElement, RestPresentation, RestTextContent, RestTextElement } from "../presentation.js";

type Paragraph = { text: string; bullet?: { nestingLevel?: number; glyph?: string }; link?: string };

export function textContent(...paragraphs: Paragraph[]): RestTextContent {
  const textElements: RestTextElement[] = [];
  let at = 0;
  for (const paragraph of paragraphs) {
    const content = `${paragraph.text}\n`;
    textElements.push({ startIndex: at, endIndex: at + content.length, paragraphMarker: paragraph.bullet ? { bullet: { listId: "list.1", ...paragraph.bullet } } : {} });
    textElements.push({ startIndex: at, endIndex: at + content.length, textRun: { content, style: paragraph.link ? { link: { url: paragraph.link } } : {} } });
    at += content.length;
  }
  return { textElements };
}

export function shape(objectId: string, paragraphs: Paragraph[], placeholder?: string): RestPageElement {
  return { objectId, shape: { shapeType: "TEXT_BOX", text: textContent(...paragraphs), ...(placeholder ? { placeholder: { type: placeholder } } : {}) } };
}

export function slide(objectId: string, elements: RestPageElement[], notes?: string, extra: Partial<RestPage> = {}): RestPage {
  const notesId = `${objectId}-notes`;
  return {
    objectId,
    pageType: "SLIDE",
    pageElements: elements,
    ...extra,
    slideProperties: {
      layoutObjectId: "layout-1",
      ...extra.slideProperties,
      notesPage: {
        objectId: `${objectId}-notes-page`,
        pageType: "NOTES",
        notesProperties: { speakerNotesObjectId: notesId },
        pageElements: [
          { objectId: `${objectId}-thumb`, image: {} },
          { objectId: notesId, shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY" }, ...(notes === undefined ? {} : { text: textContent(...notes.split("\n").map((text) => ({ text }))) }) } },
        ],
      },
    },
  };
}

export const DECK: RestPresentation = {
  presentationId: "deck-synthetic-1",
  title: "Synthetic quarterly review",
  revisionId: "rev-deck-1",
  slides: [
    slide("s1", [
      shape("s1-title", [{ text: "Quarterly review" }], "CENTERED_TITLE"),
      shape("s1-sub", [{ text: "Prepared for the team" }], "SUBTITLE"),
    ], "Welcome everyone.\nKeep it short."),
    slide("s2", [
      shape("s2-title", [{ text: "Highlights" }], "TITLE"),
      shape("s2-body", [
        { text: "Revenue up", bullet: { glyph: "●" } },
        { text: "Two regions", bullet: { nestingLevel: 1, glyph: "○" } },
        { text: "Details", bullet: { glyph: "●" }, link: "https://example.test/details" },
      ], "BODY"),
      { objectId: "s2-img", title: "Growth chart", image: { contentUrl: "https://lh3.example.test/img" } },
      { objectId: "s2-line", line: {} },
    ]),
    slide("s3", [
      {
        objectId: "s3-table",
        table: {
          rows: 2,
          columns: 2,
          tableRows: [
            { tableCells: [{ location: { rowIndex: 0, columnIndex: 0 }, text: textContent({ text: "Region" }) }, { location: { rowIndex: 0, columnIndex: 1 }, text: textContent({ text: "Total" }) }] },
            { tableCells: [{ location: { rowIndex: 1, columnIndex: 0 }, text: textContent({ text: "North | East" }) }, { location: { rowIndex: 1, columnIndex: 1 }, text: textContent({ text: "12" }, { text: "up 3" }) }] },
          ],
        },
      },
      {
        objectId: "s3-group",
        elementGroup: {
          children: [
            shape("s3-g1", [{ text: "Grouped note" }]),
            { objectId: "s3-video", video: { url: "https://www.youtube.com/watch?v=synthetic", source: "YOUTUBE", id: "synthetic" } },
          ],
        },
      },
    ], "", { slideProperties: { isSkipped: true } }),
  ],
  layouts: [{ objectId: "layout-1", pageElements: [{ objectId: "l-ph", shape: { placeholder: { type: "TITLE" }, text: textContent({ text: "Click to add title" }) } }] }],
  masters: [{ objectId: "master-1", pageElements: [{ objectId: "m-footer", shape: { text: textContent({ text: "Synthetic Co confidential" }) } }] }],
};

export const DECK_TEXT = [
  "## Slide 1",
  "### Quarterly review",
  "",
  "Prepared for the team",
  "",
  "Speaker notes:",
  "Welcome everyone.",
  "Keep it short.",
  "",
  "## Slide 2",
  "### Highlights",
  "",
  "● Revenue up",
  "  ○ Two regions",
  "● [Details](https://example.test/details)",
  "",
  "[image: Growth chart]",
  "",
  "## Slide 3 (skipped)",
  "| Region | Total |",
  "| --- | --- |",
  "| North \\| East | 12<br>up 3 |",
  "",
  "Grouped note",
  "",
  "[video: https://www.youtube.com/watch?v=synthetic]",
].join("\n");
