import { describe, expect, it } from "vitest";
import type { RestDocument, RestDocumentTab, RestStructuralElement } from "./document.js";
import { cell, MULTI_TAB_DOCUMENT, MULTI_TAB_TEXT, oneTab, para, run, table, text } from "./fixtures/docs-rest.js";
import { formatListNumber, INLINE_NOTE, renderDocument } from "./render.js";

const render = (body: RestStructuralElement[], extra: RestDocumentTab = {}) => renderDocument(oneTab(body, extra)).text;

describe("read_doc text rendering", () => {
  it("renders a whole multi-tab document: headings, links, lists, tables, images, suggestions, headers, footers, footnotes and child tabs", () => {
    const content = renderDocument(MULTI_TAB_DOCUMENT);
    expect(content.text).toBe(MULTI_TAB_TEXT);
    expect(content).toMatchObject({ documentId: "doc-synthetic-multi", title: "Synthetic launch plan", revisionId: "ALm37BV-synthetic-rev" });
    expect(content.notes).toEqual([
      INLINE_NOTE,
      "1 image is shown as [image] with its title or alt text; the picture itself is not included.",
      "1 equation is shown as [equation]; the Docs API does not return equation content.",
    ]);
  });

  it.each([
    ["TITLE", "# Words"],
    ["SUBTITLE", "## Words"],
    ["HEADING_1", "# Words"],
    ["HEADING_2", "## Words"],
    ["HEADING_3", "### Words"],
    ["HEADING_4", "#### Words"],
    ["HEADING_5", "##### Words"],
    ["HEADING_6", "###### Words"],
    ["NORMAL_TEXT", "Words"],
  ])("renders a %s paragraph as %j", (namedStyleType, expected) => {
    expect(render([text("Words", { paragraphStyle: { namedStyleType } })])).toBe(expected);
  });

  it("leaves an empty heading paragraph empty", () => {
    expect(render([text("Above"), text("", { paragraphStyle: { namedStyleType: "HEADING_1" } }), text("Below")])).toBe("Above\n\nBelow");
  });

  it.each([
    ["unordered, nested three deep", [{ glyphSymbol: "●" }, { glyphSymbol: "○" }, { glyphSymbol: "■" }], [0, 1, 2, 1, 0], ["- a", "  - b", "    - c", "  - d", "- e"]],
    ["decimal with lettered sub-items, restarting the sub-level", [{ glyphType: "DECIMAL", glyphFormat: "%0." }, { glyphType: "ALPHA", glyphFormat: "%1." }], [0, 1, 1, 0, 1], ["1. a", "  a. b", "  b. c", "2. d", "  a. e"]],
    ["nested decimal format", [{ glyphType: "DECIMAL", glyphFormat: "%0." }, { glyphType: "DECIMAL", glyphFormat: "%0.%1." }], [0, 1, 1, 0], ["1. a", "  1.1. b", "  1.2. c", "2. d"]],
    ["roman and upper alpha with parentheses", [{ glyphType: "UPPER_ROMAN", glyphFormat: "%0)" }, { glyphType: "UPPER_ALPHA", glyphFormat: "(%1)" }], [0, 0, 0, 1], ["I) a", "II) b", "III) c", "  (A) d"]],
    ["custom start number", [{ glyphType: "DECIMAL", glyphFormat: "%0.", startNumber: 5 }], [0, 0], ["5. a", "6. b"]],
    ["zero-padded decimal", [{ glyphType: "ZERO_DECIMAL", glyphFormat: "%0." }], [0, 0], ["01. a", "02. b"]],
    ["checklist without a glyph", [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }], [0, 0], ["- a", "- b"]],
  ] as const)("renders a %s list", (_name, nestingLevels, levels, expected) => {
    const body = levels.map((nestingLevel, index) => text(String.fromCharCode(97 + index), { bullet: { listId: "kix.l", nestingLevel } }));
    expect(render(body, { lists: { "kix.l": { listProperties: { nestingLevels: [...nestingLevels] } } } })).toBe(expected.join("\n"));
  });

  it("keeps numbering a list across an interrupting paragraph, and numbers separate lists separately", () => {
    const lists = {
      "kix.a": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }] } },
      "kix.b": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }] } },
    };
    const body = [
      text("one", { bullet: { listId: "kix.a" } }),
      text("between"),
      text("two", { bullet: { listId: "kix.a" } }),
      text("other", { bullet: { listId: "kix.b" } }),
    ];
    expect(render(body, { lists })).toBe("1. one\nbetween\n2. two\n1. other");
  });

  it("renders a bullet whose list is missing as an unordered item", () => {
    expect(render([text("orphan", { bullet: { listId: "kix.missing", nestingLevel: 1 } })])).toBe("  - orphan");
  });

  it.each([
    ["a web link", { url: "https://example.test/a" }, "[here](https://example.test/a)"],
    ["a heading link", { heading: { id: "h.abc", tabId: "t.0" } }, "[here](#heading=h.abc)"],
    ["a legacy heading link", { headingId: "h.old" }, "[here](#heading=h.old)"],
    ["a bookmark link", { bookmark: { id: "id.bm" } }, "[here](#bookmark=id.bm)"],
    ["a tab link", { tabId: "t.9" }, "[here](#tab=t.9)"],
    ["an empty link", {}, "here"],
  ])("renders %s", (_name, link, expected) => {
    expect(render([para([run("Go "), run("here", { textStyle: { link } }), run("\n")])])).toBe(`Go ${expected}`);
  });

  it("keeps a link's closing bracket before the paragraph's newline", () => {
    expect(render([para([run("whole line\n", { textStyle: { link: { url: "https://example.test" } } })]), text("next")])).toBe("[whole line](https://example.test)\nnext");
  });

  it.each([
    ["an image with a title", { title: "Logo", imageProperties: {} }, "[image: Logo]", "1 image is"],
    ["an image with only alt text", { description: "A  red\nlogo", imageProperties: {} }, "[image: A red logo]", "1 image is"],
    ["an image with no description", { imageProperties: {} }, "[image]", "1 image is"],
    ["a drawing", { embeddedDrawingProperties: {} }, "[drawing]", "1 drawing is"],
    ["a linked chart", { title: "Sales", linkedContentReference: { sheetsChartReference: {} } }, "[chart: Sales]", "1 chart is"],
  ])("renders %s and says what was left out", (_name, embeddedObject, expected, note) => {
    const document = oneTab([para([run("A "), { inlineObjectElement: { inlineObjectId: "obj" } }, run("\n")])], {
      inlineObjects: { obj: { inlineObjectProperties: { embeddedObject } } },
    });
    const content = renderDocument(document);
    expect(content.text).toBe(`A ${expected}`);
    expect(content.notes[1]).toMatch(new RegExp(`^${note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("renders positioned images after their paragraph and counts them", () => {
    const document = oneTab([text("Caption", { positionedObjectIds: ["pos1", "pos2"] }), text("", { positionedObjectIds: ["pos3"] })], {
      positionedObjects: {
        pos1: { positionedObjectProperties: { embeddedObject: { title: "Map", imageProperties: {} } } },
        pos2: { positionedObjectProperties: { embeddedObject: { imageProperties: {} } } },
        pos3: { positionedObjectProperties: { embeddedObject: { description: "Floor plan", imageProperties: {} } } },
      },
    });
    const content = renderDocument(document);
    expect(content.text).toBe("Caption [image: Map] [image]\n[image: Floor plan]");
    expect(content.notes).toEqual([INLINE_NOTE, "3 images are shown as [image] with its title or alt text; the picture itself is not included."]);
  });

  it.each([
    ["a person chip with name and email", { person: { personProperties: { name: "Avery", email: "avery@example.test" } } }, "Avery <avery@example.test>"],
    ["a person chip with only an email", { person: { personProperties: { email: "blake@example.test" } } }, "blake@example.test"],
    ["a rich link", { richLink: { richLinkProperties: { title: "Budget", uri: "https://docs.google.com/spreadsheets/d/abc" } } }, "[Budget](https://docs.google.com/spreadsheets/d/abc)"],
    ["a date chip", { dateElement: { dateElementProperties: { displayText: "Nov 17, 2026" } } }, "Nov 17, 2026"],
    ["a date chip without display text", { dateElement: {} }, "[date]"],
    ["a page break", { pageBreak: {} }, "[page break]"],
    ["a column break", { columnBreak: {} }, "[column break]"],
    ["a horizontal rule", { horizontalRule: {} }, "---"],
    ["a page count", { autoText: { type: "PAGE_COUNT" } }, "[page count]"],
    ["other automatic text", { autoText: { type: "TYPE_UNSPECIFIED" } }, "[auto text]"],
  ])("renders %s", (_name, element, expected) => {
    expect(render([para([run("x "), element, run("\n")])])).toBe(`x ${expected}`);
  });

  it("renders a dropdown as a placeholder and says its value is not available", () => {
    const content = renderDocument(oneTab([para([{ dropdown: {} }, run("\n")])]));
    expect(content.text).toBe("[dropdown]");
    expect(content.notes).toEqual([INLINE_NOTE, "1 dropdown is shown as [dropdown]; the Docs API does not return the selected value."]);
  });

  it("turns soft line breaks into new lines inside the same item", () => {
    expect(render([text("first\u000bsecond", { bullet: { listId: "kix.x" } })])).toBe("- first\nsecond");
  });

  it("marks suggested insertions and deletions, including on non-text items", () => {
    const content = renderDocument(oneTab([para([
      run("keep "),
      run("add", { suggestedInsertionIds: ["s1"] }),
      run(" "),
      run("drop", { suggestedDeletionIds: ["s2"] }),
      { pageBreak: { suggestedInsertionIds: ["s3"] } },
      run("\n"),
    ])]));
    expect(content.text).toBe("keep {+add+} {-drop-}{+[page break]+}");
    expect(content.notes).toEqual([INLINE_NOTE]);
  });

  it("renders tables with escaped pipes, multi-paragraph cells, nested tables and blank lines around them", () => {
    const nested = table([[cell("n1"), cell("n2")], [cell("n3"), cell("n4")]]);
    const body = [
      text("Before"),
      table([[cell("H1"), cell("H|2")], [cell("line one", "line two"), { content: [nested, text("")] }]]),
      text("After"),
    ];
    expect(render(body)).toBe([
      "Before",
      "",
      "| H1 | H\\|2 |",
      "| --- | --- |",
      "| line one<br>line two | [table: n1 / n2; n3 / n4] |",
      "",
      "After",
    ].join("\n"));
  });

  it("renders a table with a single row and an empty table", () => {
    expect(render([table([[cell("only"), cell("")]])])).toBe("| only |  |\n| --- | --- |");
    expect(render([{ startIndex: 1, endIndex: 2, table: { rows: 0, columns: 0, tableRows: [] } }])).toBe("[empty table]");
  });

  it.each([
    [
      "a header spanning two columns",
      [[{ ...cell("Q1 and Q2"), tableCellStyle: { columnSpan: 2 } }, { ...cell(""), tableCellStyle: { columnSpan: 1 } }, cell("Q3")], [cell("1"), cell("2"), cell("3")]],
      ["| Q1 and Q2 | (merged left) | Q3 |", "| --- | --- | --- |", "| 1 | 2 | 3 |"],
    ],
    [
      "a cell spanning two rows",
      [[{ ...cell("North"), tableCellStyle: { rowSpan: 2 } }, cell("x")], [cell(""), cell("y")]],
      ["| North | x |", "| --- | --- |", "| (merged up) | y |"],
    ],
    [
      "a two-by-two merge",
      [[{ ...cell("Big"), tableCellStyle: { rowSpan: 2, columnSpan: 2 } }, cell(""), cell("r")], [cell(""), cell(""), cell("s")]],
      ["| Big | (merged left) | r |", "| --- | --- | --- |", "| (merged up) | (merged up) | s |"],
    ],
    [
      "rows that leave out covered cells",
      [[{ ...cell("Wide"), tableCellStyle: { columnSpan: 2 } }], [cell("a"), cell("b")]],
      ["| Wide | (merged left) |", "| --- | --- |", "| a | b |"],
    ],
  ])("renders %s with every row as wide as the table and the merged region marked", (_name, rows, expected) => {
    const element = table(rows);
    element.table!.columns = Math.max(...rows.map((row) => row.length));
    expect(render([element])).toBe(expected.join("\n"));
  });

  it("escapes a nested table's cells exactly once, so the outer row keeps its column count", () => {
    const nested = table([[cell("a|b"), cell("c\\d")], [cell("e\u000bf"), cell("x")]]);
    const rendered = render([table([[cell("Outer"), { content: [nested] }, cell("p|q\\")]])]);
    const row = rendered.split("\n")[0]!;
    expect(row).toBe("| Outer | [table: a\\|b / c\\\\d; e<br>f / x] | p\\|q\\\\ |");
    expect(row.split(/(?<!\\)(?:\\\\)*\|/).length - 2).toBe(3);
  });

  it("marks merged cells in a nested table too", () => {
    const nested = table([[{ ...cell("Span"), tableCellStyle: { columnSpan: 2 } }, cell("")], [cell("a"), cell("b")]]);
    expect(render([table([[cell("Outer"), { content: [nested] }]])])).toBe("| Outer | [table: Span / (merged left); a / b] |\n| --- | --- |");
  });

  it("does not add a blank line after a table when the next paragraph is already empty", () => {
    expect(render([table([[cell("a")]]), text(""), text("x")])).toBe("| a |\n| --- |\n\nx");
  });

  it("renders a table of contents and section breaks after the first", () => {
    const toc: RestStructuralElement = { startIndex: 1, endIndex: 20, tableOfContents: { content: [para([run("Goals", { textStyle: { link: { heading: { id: "h.goals" } } } }), run("\n")])] } };
    expect(render([toc, { startIndex: 20, endIndex: 21, sectionBreak: {} }, text("Next section")])).toBe("[Table of contents]\n[Goals](#heading=h.goals)\n[section break]\nNext section");
  });

  it("labels first-page and even-page headers and footers", () => {
    const content = renderDocument(oneTab([text("Body")], {
      headers: { a: { content: [text("Default head")] }, b: { content: [text("First head")] } },
      footers: { c: { content: [text("Even foot")] }, d: { content: [text("Unused foot")] } },
      documentStyle: { defaultHeaderId: "a", firstPageHeaderId: "b", evenPageFooterId: "c" },
    }));
    expect(content.text).toBe("Body\n\n[Header (default)]\nDefault head\n\n[Header (first page)]\nFirst head\n\n[Footer (even pages)]\nEven foot\n\n[Footer]\nUnused foot");
    expect(content.tabs[0]!.headers.map((header) => header.kind)).toEqual(["default", "first page"]);
  });

  it("lists footnotes in number order after the body, including multi-paragraph and unreferenced ones", () => {
    const content = renderDocument(oneTab([
      para([run("A"), { footnoteReference: { footnoteId: "fn.b", footnoteNumber: "1" } }, run(" B"), { footnoteReference: { footnoteId: "fn.a", footnoteNumber: "2" } }, run("\n")]),
    ], {
      footnotes: {
        "fn.a": { content: [text(" Second note")] },
        "fn.b": { content: [text(" First note"), text("continued")] },
        "fn.c": { content: [text("Orphan")] },
      },
    }));
    expect(content.text).toBe("A[^1] B[^2]\n\n[^1]: First note continued\n[^2]: Second note\n[^?]: Orphan");
    expect(content.tabs[0]!.footnotes.map((footnote) => footnote.footnoteNumber ?? null)).toEqual(["1", "2", null]);
  });

  it("lists comments with quotes, replies and resolved state when asked, and says when there are none", () => {
    const document: RestDocument = {
      ...oneTab([text("Body")]),
      comments: [
        { commentId: "c1", anchorId: "a1", plainTextQuote: "Body", headPost: { content: "Is this\nright?", author: { displayName: "Avery" } }, replies: [{ content: "Yes", author: { displayName: "Blake" } }, { deleted: true }] },
        { commentId: "c2", status: "RESOLVED", headPost: { content: "Done", author: { anonymous: true } } },
      ],
    };
    expect(renderDocument(document, { commentsRequested: true }).text).toBe([
      "Body",
      "",
      "[Comments]",
      "- Avery: Is this right? on \"Body\"",
      "  - Blake: Yes",
      "  - (deleted)",
      "- Anonymous: Done (resolved)",
    ].join("\n"));
    expect(renderDocument(oneTab([text("Body")]), { commentsRequested: true }).text).toBe("Body\n\n[Comments]\nNo comments.");
    expect(renderDocument(document).text).toBe("Body");
  });

  it("names the tab a comment is in when the document has several tabs", () => {
    const document: RestDocument = {
      ...MULTI_TAB_DOCUMENT,
      tabs: [
        MULTI_TAB_DOCUMENT.tabs![0]!,
        { ...MULTI_TAB_DOCUMENT.tabs![1]!, documentTab: { ...MULTI_TAB_DOCUMENT.tabs![1]!.documentTab, commentAnchors: { a9: { anchorId: "a9" } } } },
      ],
      comments: [{ anchorId: "a9", headPost: { content: "Define terms", author: { displayName: "Avery" } } }],
    };
    expect(renderDocument(document, { commentsRequested: true }).text.endsWith("[Comments]\n- Avery: Define terms [Appendix]")).toBe(true);
  });

  it("renders an empty document as empty text", () => {
    expect(renderDocument({ documentId: "d", title: "Empty", tabs: [] })).toEqual({ documentId: "d", title: "Empty", suggestionsViewMode: "SUGGESTIONS_INLINE", text: "", tabs: [], notes: [INLINE_NOTE] });
    expect(render([text("")])).toBe("");
  });
});

describe("read_doc structure", () => {
  it("gives every paragraph its indices and exact text, with one U+FFFC per non-text index", () => {
    const content = renderDocument(MULTI_TAB_DOCUMENT);
    const [plan, notes, appendix] = content.tabs;
    expect(plan).toMatchObject({ tabId: "t.0", title: "Plan" });
    expect(notes).toMatchObject({ tabId: "t.1", title: "Notes", parentTabId: "t.0", nestingLevel: 1 });
    expect(plan!.body[1]).toEqual({ type: "paragraph", startIndex: 1, endIndex: 13, text: "Launch plan\n", style: "TITLE" });
    expect(plan!.body[2]).toEqual({ type: "paragraph", startIndex: 13, endIndex: 34, text: "See the brief and ￼.\n" });
    expect(plan!.body[4]).toEqual({ type: "paragraph", startIndex: 40, endIndex: 50, text: "Ship docs\n", list: { listId: "kix.list1", nestingLevel: 0 } });
    expect(appendix!.body[2]).toEqual({ type: "paragraph", startIndex: 10, endIndex: 15, text: "￼￼￼￼\n" });
    const paragraphs = [plan!, notes!, appendix!].flatMap((tab) => tab.body).filter((element) => element.type === "paragraph");
    for (const paragraph of paragraphs) expect(paragraph.text.length, paragraph.text).toBe(paragraph.endIndex - paragraph.startIndex);
  });

  it("gives tables their size and every cell's indices and content", () => {
    const tableView = renderDocument(MULTI_TAB_DOCUMENT).tabs[0]!.body.find((element) => element.type === "table");
    expect(tableView).toMatchObject({ type: "table", startIndex: 88, endIndex: 117, rows: 2, columns: 2 });
    expect(tableView!.type === "table" && tableView!.cells[1]![0]).toEqual({
      startIndex: 102, endIndex: 109, content: [{ type: "paragraph", startIndex: 103, endIndex: 115, text: "Avery | Ops\n" }],
    });
  });

  it("keeps merged-cell spans, the section break and headers, footers and footnotes", () => {
    const merged = table([[{ ...cell("wide"), tableCellStyle: { columnSpan: 2 } }, { ...cell(""), tableCellStyle: { columnSpan: 1 } }]]);
    const tab = renderDocument(oneTab([merged])).tabs[0]!;
    expect(tab.body[0]).toEqual({ type: "sectionBreak", startIndex: 0, endIndex: 1 });
    expect(tab.body[1]!.type === "table" && tab.body[1]!.cells[0]!.map((item) => item.columnSpan ?? 1)).toEqual([2, 1]);
    const plan = renderDocument(MULTI_TAB_DOCUMENT).tabs[0]!;
    expect(plan.headers).toEqual([{ segmentId: "kix.h1", kind: "default", content: [{ type: "paragraph", startIndex: 0, endIndex: 13, text: "Confidential\n" }] }]);
    expect(plan.footnotes[0]).toMatchObject({ segmentId: "kix.fn1", footnoteNumber: "1" });
  });
});

describe("list numbers", () => {
  it.each([
    [1, "DECIMAL", "1"], [12, "DECIMAL", "12"], [3, "ZERO_DECIMAL", "03"], [10, "ZERO_DECIMAL", "10"],
    [1, "ALPHA", "a"], [26, "ALPHA", "z"], [27, "ALPHA", "aa"], [28, "UPPER_ALPHA", "AB"],
    [4, "ROMAN", "iv"], [9, "ROMAN", "ix"], [14, "UPPER_ROMAN", "XIV"], [1994, "UPPER_ROMAN", "MCMXCIV"],
    [5, undefined, "5"],
  ] as const)("formats %d as %s: %s", (value, glyphType, expected) => {
    expect(formatListNumber(value, glyphType)).toBe(expected);
  });
});
