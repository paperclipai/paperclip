import { describe, expect, it } from "vitest";
import { DECK, DECK_TEXT, shape, slide, textContent } from "./fixtures/slides-rest.js";
import type { RestPageElement, RestPresentation } from "./presentation.js";
import { elementType, renderPresentation, slidesLinkTarget, textLines } from "./render.js";

const deck = (elements: RestPageElement[], notes?: string): RestPresentation => ({ presentationId: "p", title: "T", slides: [slide("s1", elements, notes)] });
const body = (elements: RestPageElement[], notes?: string) => renderPresentation(deck(elements, notes)).text.split("\n").slice(1).join("\n");

describe("read_presentation text rendering", () => {
  it("renders every slide in order with titles, bullets, links, tables, groups, media and speaker notes", () => {
    const content = renderPresentation(DECK);
    expect(content.text).toBe(DECK_TEXT);
    expect(content).toMatchObject({ presentationId: "deck-synthetic-1", title: "Synthetic quarterly review", revisionId: "rev-deck-1" });
    expect(content.notes).toEqual([
      "1 image is shown as [image] with its title or alt text; the picture itself is not included.",
      "1 video is shown as [video] with its link when there is one.",
      "1 text item on slide masters or layouts (for example a footer or logo text shown on every slide) is not included.",
    ]);
  });

  it.each([
    ["TITLE", "### Words"],
    ["CENTERED_TITLE", "### Words"],
    ["SUBTITLE", "Words"],
    ["BODY", "Words"],
    [undefined, "Words"],
  ])("renders a %s placeholder as %j", (placeholder, expected) => {
    expect(body([shape("e", [{ text: "Words" }], placeholder)])).toBe(expected);
  });

  it("marks only the first line of a multi-paragraph title", () => {
    expect(body([shape("e", [{ text: "Line one" }, { text: "Line two" }], "TITLE")])).toBe("### Line one\nLine two");
  });

  it.each([
    ["a glyph", { glyph: "◆" }, "◆ item"],
    ["a numbered glyph", { glyph: "3." }, "3. item"],
    ["a nested glyph", { glyph: "-", nestingLevel: 2 }, "    - item"],
    ["no glyph", {}, "- item"],
    ["a glyph with spaces", { glyph: " • " }, "• item"],
  ])("renders a bullet with %s", (_name, bullet, expected) => {
    expect(body([shape("e", [{ text: "item", bullet }])])).toBe(expected);
  });

  it.each([
    ["a web link", { url: "https://example.test" }, "https://example.test"],
    ["a slide link", { pageObjectId: "s9" }, "#slide=s9"],
    ["a slide number link", { slideIndex: 2 }, "#slide-number=3"],
    ["a relative link", { relativeLink: "NEXT_SLIDE" }, "#NEXT_SLIDE"],
    ["no link", undefined, undefined],
  ])("turns %s into a target", (_name, link, expected) => {
    expect(slidesLinkTarget(link)).toBe(expected);
  });

  it("renders links inside a paragraph, automatic slide numbers and soft line breaks", () => {
    const text = {
      textElements: [
        { paragraphMarker: {} },
        { textRun: { content: "See " } },
        { textRun: { content: "slide 2", style: { link: { pageObjectId: "s2" } } } },
        { textRun: { content: " now\u000bthen\n" } },
        { paragraphMarker: {} },
        { autoText: { type: "SLIDE_NUMBER", content: "7" } },
        { textRun: { content: "\n" } },
      ],
    };
    expect(textLines(text)).toEqual(["See [slide 2](#slide=s2) now\nthen", "7"]);
  });

  it("keeps empty lines inside a shape but drops trailing ones, and renders nothing for an empty shape", () => {
    expect(body([shape("e", [{ text: "a" }, { text: "" }, { text: "b" }, { text: "" }, { text: "" }])])).toBe("a\n\nb");
    expect(body([shape("e", [{ text: "" }]), { objectId: "x", shape: { shapeType: "RECTANGLE" } }, shape("f", [{ text: "only" }])])).toBe("only");
  });

  it("renders text that starts without a paragraph marker", () => {
    expect(textLines({ textElements: [{ textRun: { content: "loose\n" } }] })).toEqual(["loose"]);
    expect(textLines(undefined)).toEqual([]);
  });

  it.each([
    ["an image with alt text", { objectId: "i", description: "A  team\nphoto", image: {} }, "[image: A team photo]", "1 image is"],
    ["an untitled image", { objectId: "i", image: {} }, "[image]", "1 image is"],
    ["a linked video", { objectId: "v", video: { url: "https://www.youtube.com/watch?v=x" } }, "[video: https://www.youtube.com/watch?v=x]", "1 video is"],
    ["a Drive video", { objectId: "v", title: "Demo", video: { source: "DRIVE", id: "f1" } }, "[video: Demo]", "1 video is"],
    ["a chart", { objectId: "c", sheetsChart: { spreadsheetId: "sheet-1", chartId: 4 } }, "[chart]", "1 chart is"],
  ] as const)("renders %s and says what was left out", (_name, element, expected, note) => {
    const content = renderPresentation(deck([element as RestPageElement]));
    expect(content.text).toBe(`## Slide 1\n${expected}`);
    expect(content.notes?.[0]?.startsWith(note)).toBe(true);
  });

  it("renders word art text, and nothing for lines and speaker spotlights", () => {
    expect(body([{ objectId: "w", wordArt: { renderedText: "BIG" } }, { objectId: "l", line: {} }, { objectId: "s", speakerSpotlight: {} }])).toBe("BIG");
  });

  it("renders tables with escaped pipes, multi-line cells and empty tables", () => {
    const table: RestPageElement = {
      objectId: "t",
      table: {
        rows: 2,
        columns: 2,
        tableRows: [
          { tableCells: [{ location: { rowIndex: 0, columnIndex: 0 }, text: textContent({ text: "A | B" }) }, { location: { rowIndex: 0, columnIndex: 1 }, text: textContent({ text: "C" }) }] },
          { tableCells: [{ location: { rowIndex: 1, columnIndex: 0 }, text: textContent({ text: "a", bullet: { glyph: "●" } }, { text: "b", bullet: { glyph: "●" } }) }, { location: { rowIndex: 1, columnIndex: 1 }, text: textContent({ text: "" }) }] },
        ],
      },
    };
    expect(body([table])).toBe("| A \\| B | C |\n| --- | --- |\n| ● a<br>● b |  |");
    expect(body([{ objectId: "e", table: { rows: 0, columns: 0, tableRows: [] } }])).toBe("[empty table]");
  });

  it.each([
    [
      "a header spanning two columns",
      3,
      [
        [{ location: { rowIndex: 0, columnIndex: 0 }, columnSpan: 2, text: textContent({ text: "Q1 and Q2" }) }, { location: { rowIndex: 0, columnIndex: 2 }, text: textContent({ text: "Q3" }) }],
        [{ location: { rowIndex: 1, columnIndex: 0 }, text: textContent({ text: "1" }) }, { location: { rowIndex: 1, columnIndex: 1 }, text: textContent({ text: "2" }) }, { location: { rowIndex: 1, columnIndex: 2 }, text: textContent({ text: "3" }) }],
      ],
      ["| Q1 and Q2 | (merged left) | Q3 |", "| --- | --- | --- |", "| 1 | 2 | 3 |"],
    ],
    [
      "a cell spanning two rows",
      2,
      [
        [{ location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 2, text: textContent({ text: "North" }) }, { location: { rowIndex: 0, columnIndex: 1 }, text: textContent({ text: "x" }) }],
        [{ location: { rowIndex: 1, columnIndex: 1 }, text: textContent({ text: "y" }) }],
      ],
      ["| North | x |", "| --- | --- |", "| (merged up) | y |"],
    ],
    [
      "a two-by-two merge without locations",
      3,
      [
        [{ rowSpan: 2, columnSpan: 2, text: textContent({ text: "Big" }) }, { text: textContent({ text: "r" }) }],
        [{ text: textContent({ text: "s" }) }],
      ],
      ["| Big | (merged left) | r |", "| --- | --- | --- |", "| (merged up) | (merged up) | s |"],
    ],
  ])("renders %s with every row as wide as the table and the merged region marked", (_name, columns, tableRows, expected) => {
    const table = { objectId: "t", table: { rows: tableRows.length, columns, tableRows: tableRows.map((tableCells) => ({ tableCells })) } } as RestPageElement;
    expect(body([table])).toBe(expected.join("\n"));
  });

  it("escapes a table cell's backslashes and pipes exactly once", () => {
    const table: RestPageElement = {
      objectId: "t",
      table: { rows: 1, columns: 2, tableRows: [{ tableCells: [{ location: { rowIndex: 0, columnIndex: 0 }, text: textContent({ text: "a\\|b" }) }, { location: { rowIndex: 0, columnIndex: 1 }, text: textContent({ text: "c" }) }] }] },
    };
    expect(body([table])).toBe("| a\\\\\\|b | c |\n| --- | --- |");
  });

  it("renders nested groups in order", () => {
    const group: RestPageElement = { objectId: "g", elementGroup: { children: [shape("a", [{ text: "outer" }]), { objectId: "g2", elementGroup: { children: [shape("b", [{ text: "inner" }])] } }] } };
    expect(body([group])).toBe("outer\n\ninner");
  });

  it("leaves out empty speaker notes and slides without a notes page", () => {
    expect(renderPresentation(deck([shape("a", [{ text: "x" }])], "")).text).toBe("## Slide 1\nx");
    const bare: RestPresentation = { slides: [{ objectId: "s", pageElements: [shape("a", [{ text: "x" }])] }] };
    expect(renderPresentation(bare)).toEqual({ presentationId: "", title: "", text: "## Slide 1\nx", slides: [{ objectId: "s", slideNumber: 1, elements: [{ objectId: "a", type: "shape", text: "x\n" }] }] });
  });

  it("renders a presentation with no slides as empty text", () => {
    expect(renderPresentation({ presentationId: "p", title: "Empty", slides: [] })).toEqual({ presentationId: "p", title: "Empty", text: "", slides: [] });
  });

  it("lists comments for the presentation and for slides when asked, and says when there are none", () => {
    const withComments: RestPresentation = {
      ...deck([shape("a", [{ text: "x" }])]),
      comments: [{ headPost: { content: "Overall fine", author: { displayName: "Avery" } } }],
    };
    withComments.slides![0]!.comments = [{ status: "RESOLVED", plainTextQuote: "x", headPost: { content: "Typo", author: { displayName: "Blake" } }, replies: [{ content: "Fixed", author: { displayName: "Avery" } }] }];
    expect(renderPresentation(withComments, { commentsRequested: true }).text).toBe([
      "## Slide 1",
      "x",
      "",
      "[Comments]",
      "- Avery: Overall fine",
      "- Blake: Typo on \"x\" [slide 1] (resolved)",
      "  - Avery: Fixed",
    ].join("\n"));
    expect(renderPresentation(deck([shape("a", [{ text: "x" }])]), { commentsRequested: true }).text).toBe("## Slide 1\nx\n\n[Comments]\nNo comments.");
    expect(renderPresentation(withComments).text).toBe("## Slide 1\nx");
  });

  it("counts master and layout text that is not a placeholder", () => {
    const presentation: RestPresentation = {
      ...deck([]),
      masters: [{ pageElements: [shape("m1", [{ text: "Footer" }]), shape("m2", [{ text: "" }]), shape("m3", [{ text: "Title" }], "TITLE")] }],
      layouts: [{ pageElements: [{ objectId: "g", elementGroup: { children: [shape("l1", [{ text: "Logo" }])] } }, { objectId: "t", table: { tableRows: [{ tableCells: [{ text: textContent({ text: "cell" }) }] }] } }] }],
    };
    expect(renderPresentation(presentation).notes).toEqual(["3 text items on slide masters or layouts (for example a footer or logo text shown on every slide) are not included."]);
  });
});

describe("read_presentation structure", () => {
  it("gives each slide its objectId, number, elements with raw text, and the speaker notes shape", () => {
    const [first, second, third] = renderPresentation(DECK).slides;
    expect(first).toEqual({
      objectId: "s1",
      slideNumber: 1,
      elements: [
        { objectId: "s1-title", type: "shape", placeholder: "CENTERED_TITLE", text: "Quarterly review\n" },
        { objectId: "s1-sub", type: "shape", placeholder: "SUBTITLE", text: "Prepared for the team\n" },
      ],
      speakerNotes: { objectId: "s1-notes", text: "Welcome everyone.\nKeep it short.\n" },
    });
    expect(second!.elements.map((element) => element.type)).toEqual(["shape", "shape", "image", "line"]);
    expect(second!.elements[1]!.text).toBe("Revenue up\nTwo regions\nDetails\n");
    expect(second!.elements[2]).toEqual({ objectId: "s2-img", type: "image", title: "Growth chart" });
    expect(third).toMatchObject({ objectId: "s3", slideNumber: 3, skipped: true });
    expect(third!.elements[0]).toEqual({
      objectId: "s3-table",
      type: "table",
      rows: 2,
      columns: 2,
      cells: [
        [{ rowIndex: 0, columnIndex: 0, text: "Region\n" }, { rowIndex: 0, columnIndex: 1, text: "Total\n" }],
        [{ rowIndex: 1, columnIndex: 0, text: "North | East\n" }, { rowIndex: 1, columnIndex: 1, text: "12\nup 3\n" }],
      ],
    });
    expect(third!.elements[1]).toEqual({
      objectId: "s3-group",
      type: "group",
      children: [{ objectId: "s3-g1", type: "shape", text: "Grouped note\n" }, { objectId: "s3-video", type: "video", url: "https://www.youtube.com/watch?v=synthetic" }],
    });
  });

  it.each([
    [{ shape: {} }, "shape"], [{ table: {} }, "table"], [{ image: {} }, "image"], [{ video: {} }, "video"], [{ line: {} }, "line"],
    [{ wordArt: {} }, "wordArt"], [{ sheetsChart: {} }, "sheetsChart"], [{ elementGroup: {} }, "group"], [{ speakerSpotlight: {} }, "speakerSpotlight"], [{}, "unknown"],
  ] as const)("names the element type of %j", (element, expected) => {
    expect(elementType(element as RestPageElement)).toBe(expected);
  });

  it("gives a chart its spreadsheet and chart IDs", () => {
    expect(renderPresentation(deck([{ objectId: "c", sheetsChart: { spreadsheetId: "sheet-1", chartId: 4 } }])).slides[0]!.elements[0]).toEqual({ objectId: "c", type: "sheetsChart", spreadsheetId: "sheet-1", chartId: 4 });
  });
});
