import { describe, expect, it } from "vitest";
import { inputFileAttachmentMatches, inputFileFixture, inputFileSummaryMatches } from "./input-file-evidence.js";

describe("uploaded input evidence", () => {
  const fixture = inputFileFixture("fresh-unpredictable-reference");
  it("grades the uploaded values rather than a fixed sample answer", () => {
    expect(inputFileSummaryMatches(JSON.stringify(fixture.expected), fixture.expected)).toBe(true);
    expect(inputFileSummaryMatches(`\`\`\`json\n${JSON.stringify(fixture.expected)}\n\`\`\``, fixture.expected)).toBe(true);
    const other = inputFileFixture("a-different-input");
    expect(inputFileSummaryMatches(JSON.stringify(other.expected), fixture.expected)).toBe(false);
  });
  it.each([
    null, "", "I read the file successfully", "{}", "[]",
    JSON.stringify({ ...fixture.expected, acceptedRows: 5 }),
    JSON.stringify({ ...fixture.expected, acceptedUnits: fixture.expected.acceptedUnits + 1 }),
    JSON.stringify({ ...fixture.expected, reference: "another-task" }),
    JSON.stringify({ ...fixture.expected, unsupported: "extra assertion" }),
  ])("rejects missing, wrong or unsupported output %j", body => {
    expect(inputFileSummaryMatches(body, fixture.expected)).toBe(false);
  });
  it("requires the exact uploaded bytes on the owned task and preserves their identity", () => {
    const attachment = { id: "input-file", companyId: "company", issueId: "task",
      originalFilename: fixture.filename, originatingRunId: null, byteSize: fixture.bytes.length };
    const input = { companyId: "company", issueId: "task", fixture, downloaded: fixture.bytes };
    expect(inputFileAttachmentMatches(attachment, input)).toBe(true);
    expect(inputFileAttachmentMatches(undefined, input)).toBe(false);
    for (const change of [{ companyId: "foreign" }, { issueId: "foreign" }, { originatingRunId: "agent-created-replacement" },
      { originalFilename: "different.csv" }, { byteSize: fixture.bytes.length + 1 }]) {
      expect(inputFileAttachmentMatches({ ...attachment, ...change }, input)).toBe(false);
    }
    expect(inputFileAttachmentMatches(attachment, { ...input, downloaded: Buffer.from("replacement") })).toBe(false);
  });
});
