import type {
  RestDocument,
  RestDocumentTab,
  RestParagraph,
  RestParagraphElement,
  RestStructuralElement,
  RestTab,
  RestTableCell,
} from "../document.js";

export function run(content: string, extra: Partial<NonNullable<RestParagraphElement["textRun"]>> = {}): RestParagraphElement {
  return { textRun: { content, ...extra } };
}

export function withIndices(start: number, elements: RestParagraphElement[]): { elements: RestParagraphElement[]; end: number } {
  let at = start;
  const placed = elements.map((element) => {
    const length = element.textRun ? (element.textRun.content ?? "").length : 1;
    const result = { startIndex: at, endIndex: at + length, ...element };
    at += length;
    return result;
  });
  return { elements: placed, end: at };
}

export function para(elements: RestParagraphElement[], style: Omit<RestParagraph, "elements"> = {}, start = 1): RestStructuralElement {
  const placed = withIndices(start, elements);
  return { startIndex: start, endIndex: placed.end, paragraph: { elements: placed.elements, ...style } };
}

export function text(value: string, style: Omit<RestParagraph, "elements"> = {}): RestStructuralElement {
  return para([run(`${value}\n`)], style);
}

export function cell(...paragraphs: string[]): RestTableCell {
  return { content: paragraphs.map((value) => text(value)) };
}

export function table(rows: RestTableCell[][]): RestStructuralElement {
  return { startIndex: 1, endIndex: 2, table: { rows: rows.length, columns: rows[0]?.length ?? 0, tableRows: rows.map((tableCells) => ({ tableCells })) } };
}

export function oneTab(body: RestStructuralElement[], extra: RestDocumentTab = {}): RestDocument {
  return {
    documentId: "doc-synthetic-1",
    title: "Synthetic",
    revisionId: "rev-1",
    tabs: [{ tabProperties: { tabId: "t.0", title: "Tab 1", index: 0 }, documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, ...body] }, ...extra } }],
  };
}

const PLAN_TAB: RestTab = {
  tabProperties: { tabId: "t.0", title: "Plan", index: 0 },
  documentTab: {
    body: {
      content: [
        { endIndex: 1, sectionBreak: {} },
        para([run("Launch plan\n")], { paragraphStyle: { namedStyleType: "TITLE" } }, 1),
        para([
          run("See "),
          run("the brief", { textStyle: { link: { url: "https://example.test/brief" } } }),
          run(" and "),
          { footnoteReference: { footnoteId: "kix.fn1", footnoteNumber: "1" } },
          run(".\n"),
        ], {}, 13),
        para([run("Goals\n")], { paragraphStyle: { namedStyleType: "HEADING_1", headingId: "h.goals" } }, 34),
        para([run("Ship docs\n")], { bullet: { listId: "kix.list1" } }, 40),
        para([run("Write tests\n")], { bullet: { listId: "kix.list1", nestingLevel: 1 } }, 50),
        para([run("First\n")], { bullet: { listId: "kix.list2" } }, 62),
        para([run("Second\n")], { bullet: { listId: "kix.list2" } }, 68),
        para([run("Detail\n")], { bullet: { listId: "kix.list2", nestingLevel: 1 } }, 75),
        para([run("Third\n")], { bullet: { listId: "kix.list2" } }, 82),
        {
          startIndex: 88,
          endIndex: 117,
          table: {
            rows: 2,
            columns: 2,
            tableRows: [
              { tableCells: [{ startIndex: 89, endIndex: 96, content: [para([run("Owner\n")], {}, 90)] }, { startIndex: 96, endIndex: 101, content: [para([run("Due\n")], {}, 97)] }] },
              { tableCells: [{ startIndex: 102, endIndex: 109, content: [para([run("Avery | Ops\n")], {}, 103)] }, { startIndex: 109, endIndex: 116, content: [para([run("Friday\n")], {}, 110)] }] },
            ],
          },
        },
        para([{ inlineObjectElement: { inlineObjectId: "kix.img1" } }, run("\n")], {}, 117),
        para([
          run("Status: "),
          run("new", { suggestedInsertionIds: ["suggest.1"] }),
          run("old", { suggestedDeletionIds: ["suggest.2"] }),
          run("\n"),
        ], {}, 119),
        para([run("\n")], {}, 134),
      ],
    },
    headers: { "kix.h1": { headerId: "kix.h1", content: [para([run("Confidential\n")], {}, 0)] } },
    footers: { "kix.f1": { footerId: "kix.f1", content: [para([{ autoText: { type: "PAGE_NUMBER" } }, run("\n")], {}, 0)] } },
    footnotes: { "kix.fn1": { footnoteId: "kix.fn1", content: [para([run(" Source: survey.\n")], {}, 0)] } },
    documentStyle: { defaultHeaderId: "kix.h1", defaultFooterId: "kix.f1" },
    lists: {
      "kix.list1": { listProperties: { nestingLevels: [{ glyphSymbol: "●", glyphFormat: "%0" }, { glyphSymbol: "○", glyphFormat: "%1" }] } },
      "kix.list2": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", glyphFormat: "%0." }, { glyphType: "ALPHA", glyphFormat: "%1." }] } },
    },
    inlineObjects: { "kix.img1": { inlineObjectProperties: { embeddedObject: { title: "Roadmap chart", imageProperties: {} } } } },
  },
  childTabs: [
    {
      tabProperties: { tabId: "t.1", title: "Notes", parentTabId: "t.0", index: 0, nestingLevel: 1 },
      documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, para([run("Child tab text\n")], {}, 1)] } },
    },
  ],
};

const APPENDIX_TAB: RestTab = {
  tabProperties: { tabId: "t.2", title: "Appendix", index: 1 },
  documentTab: {
    body: {
      content: [
        { endIndex: 1, sectionBreak: {} },
        para([run("Glossary\n")], { paragraphStyle: { namedStyleType: "HEADING_2" } }, 1),
        { startIndex: 10, endIndex: 15, paragraph: { elements: [{ startIndex: 10, endIndex: 14, equation: {} }, { startIndex: 14, endIndex: 15, textRun: { content: "\n" } }] } },
      ],
    },
  },
};

export const MULTI_TAB_DOCUMENT: RestDocument = {
  documentId: "doc-synthetic-multi",
  title: "Synthetic launch plan",
  revisionId: "ALm37BV-synthetic-rev",
  tabs: [PLAN_TAB, APPENDIX_TAB],
};

export const MULTI_TAB_TEXT = [
  "=== Tab: Plan ===",
  "# Launch plan",
  "See [the brief](https://example.test/brief) and [^1].",
  "# Goals",
  "- Ship docs",
  "  - Write tests",
  "1. First",
  "2. Second",
  "  a. Detail",
  "3. Third",
  "",
  "| Owner | Due |",
  "| --- | --- |",
  "| Avery \\| Ops | Friday |",
  "",
  "[image: Roadmap chart]",
  "Status: {+new+}{-old-}",
  "",
  "[Header (default)]",
  "Confidential",
  "",
  "[Footer (default)]",
  "[page number]",
  "",
  "[^1]: Source: survey.",
  "",
  "=== Tab: Plan / Notes ===",
  "Child tab text",
  "",
  "=== Tab: Appendix ===",
  "## Glossary",
  "[equation]",
].join("\n");
