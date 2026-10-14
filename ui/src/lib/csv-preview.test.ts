import { describe, expect, it } from "vitest";
import { isCsvFile, parseCsv } from "./csv-preview";

describe("CSV preview parsing", () => {
  it("handles BOM, CRLF, quoted commas, escaped quotes and multiline cells", () => {
    expect(parseCsv('\uFEFFName,Notes,Amount\r\n"Lee, Sam","Said ""hello""\nagain",12\r\n')).toEqual([
      ["Name", "Notes", "Amount"], ["Lee, Sam", 'Said "hello"\nagain', "12"],
    ]);
  });
  it("preserves trailing empty fields, blank records and uneven rows", () => {
    expect(parseCsv("a,b\n1,\n\n2,3,4")).toEqual([["a", "b"], ["1", ""], [""], ["2", "3", "4"]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
  });
  it("reports incomplete quoted fields", () => {
    expect(() => parseCsv('a,b\n"unfinished')).toThrow("incomplete");
  });
  it("recognizes CSV filenames and media types", () => {
    expect(isCsvFile("EXPORT.CSV", "application/octet-stream")).toBe(true);
    expect(isCsvFile("download", "text/csv; charset=utf-8")).toBe(true);
    expect(isCsvFile("notes.txt", "text/plain")).toBe(false);
  });
});
