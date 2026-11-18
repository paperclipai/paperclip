import { describe, expect, it } from "vitest";
import { assertRequestKinds, escapeTableCell, googleFileUrl, isRevisionConflict, markdownTable, refuseGoogleFileUrl, tableGrid, type RequestKindRules } from "./documents-shared.js";
import { GoogleToolError, type GoogleErrorDetail } from "./errors.js";

describe("revision conflicts", () => {
  it.each([
    ["status FAILED_PRECONDITION with an unrelated message", 400, "Precondition check failed.", { status: "FAILED_PRECONDITION" }, true],
    ["status ABORTED on 409", 409, "Aborted.", { status: "ABORTED" }, true],
    ["a revision reason in the details", 400, "Request failed.", { status: "INVALID_ARGUMENT", reasons: ["REVISION_MISMATCH"] }, true],
    ["a legacy conditionNotMet reason", 400, "Request failed.", { reasons: ["conditionNotMet"] }, true],
    ["only the message, as a fallback", 400, "The required revision ID 'r1' does not match the latest revision.", { status: "INVALID_ARGUMENT" }, true],
    ["a message that names the revision ID, with no structured fields", 400, "Invalid revision ID.", {}, true],
    ["an unrelated invalid request", 400, "Invalid requests[0].insertText: Index 99 must be less than the end index.", { status: "INVALID_ARGUMENT" }, false],
    ["an unrelated message that only mentions revisions", 400, "Invalid requests[0]: revisions of this kind are not allowed.", { status: "INVALID_ARGUMENT" }, false],
    ["a 413", 413, "Too large: required revision", { status: "FAILED_PRECONDITION" }, false],
  ] as const)("%s: %s", (_name, httpStatus, message, google, expected) => {
    const error = new GoogleToolError("invalid_argument", message, httpStatus, google as GoogleErrorDetail);
    expect(isRevisionConflict(error)).toBe(expected);
  });

  it("never treats other kinds of failure as a conflict", () => {
    expect(isRevisionConflict(new GoogleToolError("permission_denied", "required revision", 403, { status: "FAILED_PRECONDITION" }))).toBe(false);
    expect(isRevisionConflict(new GoogleToolError("unavailable", "x", 503))).toBe(false);
  });
});

describe("request kinds", () => {
  const rules: RequestKindRules = {
    insertText: { allowed: true },
    createImage: { allowed: true, refuse: refuseGoogleFileUrl("url") },
    createSheetsChart: { allowed: false, reason: "reads another file." },
  };

  it("names every refused request by position, and says nothing was changed", () => {
    expect(() => assertRequestKinds([{ insertText: {} }, { createSheetsChart: {} }, { mystery: {} }, { createImage: { url: "https://drive.google.com/uc?id=f1" } }], rules))
      .toThrow("requests[1].createSheetsChart reads another file. requests[2].mystery is not a request kind this tool accepts. requests[3].createImage takes its picture from a Google Drive or Docs link (url), which is another file. This tool only changes the one file it is given, so nothing was changed.");
  });

  it("refuses kinds named like object properties, and accepts allowed forms", () => {
    expect(() => assertRequestKinds([{ toString: {} }], rules)).toThrow(/requests\[0\]\.toString is not a request kind/);
    expect(() => assertRequestKinds([{ constructor: {} }], rules)).toThrow(/requests\[0\]\.constructor is not a request kind/);
    expect(() => assertRequestKinds([{ insertText: {} }, { createImage: { url: "https://example.test/a.png" } }, { createImage: "x" }], rules)).not.toThrow();
  });

  it.each([
    ["https://drive.google.com/file/d/f1/view", true],
    ["https://DOCS.google.com/document/d/x", true],
    ["https://lh3.googleusercontent.com/abc", false],
    ["https://example.test/drive.google.com.png", false],
    ["not a url", false],
    [42, false],
  ])("treats %s as a Google file link: %s", (value, expected) => {
    expect(googleFileUrl(value)).toBe(expected);
  });
});

describe("table grid", () => {
  it("pads short rows, widens for spans past the stated width, and stops row spans at the last row", () => {
    expect(tableGrid([[{ text: "a" }], [{ text: "b", columnSpan: 3, rowSpan: 4 }]], 2)).toEqual([
      ["a", "", ""],
      ["b", "(merged left)", "(merged left)"],
    ]);
  });

  it("places cells by their column when given", () => {
    expect(tableGrid([[{ text: "z", column: 2 }, { text: "x", column: 0 }]], 3)).toEqual([["x", "", "z"]]);
  });

  it("places cells by their row when given", () => {
    expect(tableGrid([[{ text: "top", column: 0 }], [{ text: "moved", row: 0, column: 1 }, { text: "own", column: 0 }]], 2)).toEqual([["top", "moved"], ["own", ""]]);
  });

  it.each([
    ["a|b", "a\\|b"],
    ["c\\d", "c\\\\d"],
    ["ends\\", "ends\\\\"],
    ["e\\|f", "e\\\\\\|f"],
    ["g\nh\r\ni", "g<br>h<br>i"],
  ])("escapes the table cell %j once as %j", (raw, escaped) => {
    expect(escapeTableCell(raw)).toBe(escaped);
    expect(markdownTable([[{ text: raw }, { text: "z" }]], 2)[0]).toBe(`| ${escaped} | z |`);
  });

  it("renders an empty table", () => {
    expect(markdownTable([], 0)).toEqual(["[empty table]"]);
  });
});
