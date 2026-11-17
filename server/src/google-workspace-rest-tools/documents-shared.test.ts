import { describe, expect, it } from "vitest";
import { assertRequestKinds, isRevisionConflict, markdownTable, tableGrid } from "./documents-shared.js";
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
  const blocked = { createSheetsChart: "reads another file." };

  it("refuses blocked kinds by name, once each", () => {
    expect(() => assertRequestKinds([{ insertText: {} }, { createSheetsChart: {} }, { createSheetsChart: {} }], blocked))
      .toThrow("createSheetsChart reads another file. This tool only changes the one file it is given. Nothing was changed.");
  });

  it("allows everything else, including kinds named like object properties", () => {
    expect(() => assertRequestKinds([{ insertText: {} }, { toString: {} }, { constructor: {} }], blocked)).not.toThrow();
    expect(() => assertRequestKinds([{ createSheetsChart: {} }], {})).not.toThrow();
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

  it("renders an empty table", () => {
    expect(markdownTable([], 0)).toEqual(["[empty table]"]);
  });
});
