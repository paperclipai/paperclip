import { describe, expect, it } from "vitest";
import { GoogleToolError } from "../errors.js";
import { driveSearchQuery, quote, tokenize } from "./query.js";

describe("driveSearchQuery", () => {
  it.each([
    [undefined, "trashed = false"],
    ["", "trashed = false"],
    ["   ", "trashed = false"],
    ["title contains 'hello'", "(name contains 'hello') and trashed = false"],
    ["title = 'Plan'", "(name = 'Plan') and trashed = false"],
    ["title != 'Plan'", "(name != 'Plan') and trashed = false"],
    ["fullText contains 'launch'", "(fullText contains 'launch') and trashed = false"],
    ["mimeType = 'application/pdf'", "(mimeType = 'application/pdf') and trashed = false"],
    ["mimeType contains 'image/'", "(mimeType contains 'image/') and trashed = false"],
    ["modifiedTime > '2024-01-01T00:00:00Z'", "(modifiedTime > '2024-01-01T00:00:00Z') and trashed = false"],
    ["createdTime <= '2012-06-04T12:00:00-08:00'", "(createdTime <= '2012-06-04T12:00:00-08:00') and trashed = false"],
    ["viewedByMeTime >= '2026-11-01T00:00:00.123Z'", "(viewedByMeTime >= '2026-11-01T00:00:00.123Z') and trashed = false"],
    ["parentId = 'root'", "('root' in parents) and trashed = false"],
    ["parentId != 'folder1'", "(not 'folder1' in parents) and trashed = false"],
    ["owner = 'me'", "('me' in owners) and trashed = false"],
    ["owner != 'test@example.org'", "(not 'test@example.org' in owners) and trashed = false"],
    ["'me' in readers", "('me' in readers) and trashed = false"],
    ["'colleague@example.org' in writers", "('colleague@example.org' in writers) and trashed = false"],
    ["visibility = 'anyoneWithLink'", "(visibility = 'anyoneWithLink') and trashed = false"],
    ["visibility = 'anyone'", "((visibility = 'anyoneCanFind' or visibility = 'anyoneWithLink')) and trashed = false"],
    ["visibility != 'domain'", "(not (visibility = 'domainCanFind' or visibility = 'domainWithLink')) and trashed = false"],
    ["sharedWithMe = true", "(sharedWithMe = true) and trashed = false"],
    ["starred = false", "(starred = false) and trashed = false"],
    ["starred = TRUE", "(starred = true) and trashed = false"],
    ["trashed = true", "trashed = true"],
    ["title contains 'x' and trashed = true", "(name contains 'x' and trashed = true)"],
    ["not trashed = false", "not trashed = false"],
    [
      "title contains 'hello' and title contains 'goodbye'",
      "((name contains 'hello' and name contains 'goodbye')) and trashed = false",
    ],
    [
      "modifiedTime > '2024-01-01T00:00:00Z' and (mimeType contains 'image/' or mimeType contains 'video/')",
      "((modifiedTime > '2024-01-01T00:00:00Z' and (mimeType contains 'image/' or mimeType contains 'video/'))) and trashed = false",
    ],
    ["title = 'x' or title = 'y'", "((name = 'x' or name = 'y')) and trashed = false"],
    ["owner = 'me' AND NOT starred = true", "(('me' in owners and not starred = true)) and trashed = false"],
    ["title contains \"double\"", "(name contains 'double') and trashed = false"],
  ])("translates %j", (query, expected) => {
    expect(driveSearchQuery(query)).toBe(expected);
  });

  it.each([
    ["title contains 'O\\'Brien'", "(name contains 'O\\'Brien') and trashed = false"],
    ["title contains 'back\\\\slash'", "(name contains 'back\\\\slash') and trashed = false"],
    ["title contains 'x\\' or trashed = true or name contains \\'y'", "(name contains 'x\\' or trashed = true or name contains \\'y') and trashed = false"],
    ["title contains \"it's\"", "(name contains 'it\\'s') and trashed = false"],
    ["title contains \"a\\\\' or 'b\"", "(name contains 'a\\\\\\' or \\'b') and trashed = false"],
    ["title contains 'x) or (trashed = true'", "(name contains 'x) or (trashed = true') and trashed = false"],
  ])("keeps quotes, backslashes and operators inside a value: %j", (query, expected) => {
    expect(driveSearchQuery(query)).toBe(expected);
  });

  it("escapes values so the result always parses back to the same value", () => {
    for (const value of ["'", "\\", "\\'", "'\\", "a' or 'b", "x\\' or trashed = true or name contains \\'", "''''", "\\\\\\"]) {
      const tokens = tokenize(quote(value));
      expect(tokens).toEqual([{ kind: "string", value }]);
    }
  });

  it.each([
    ["title contains 'x", /not closed/],
    ["title contains 'x\\", /not closed|backslash/],
    ["title", /expected an operator/],
    ["title contains", /expected a quoted value/],
    ["title contains x", /expected a quoted value/],
    ["title > 'x'", /does not support the > operator/],
    ["fullText = 'x'", /does not support the = operator/],
    ["modifiedTime > 'yesterday'", /RFC 3339/],
    ["starred = 'true'", /true or false/],
    ["title = true", /quoted value/],
    ["creator = 'me'", /creator term is not supported/],
    ["sharedFrom = 'a@example.test'", /sharedFrom term is not supported/],
    ["sharedTo = 'a@example.test'", /sharedTo term is not supported/],
    ["followUp = 'any'", /followUp term is not supported/],
    ["'syncedComputer' in folderProperties", /folderProperties term is not supported/],
    ["'me' in owners", /works only with readers and writers/],
    ["visibility = 'external'", /not supported/],
    ["name contains 'x'", /unknown term "name"/],
    ["title contains 'x' and", /expected a search term/],
    ["(title contains 'x'", /expected "\)"/],
    ["title contains 'x')", /unexpected "\)"/],
    ["title contains 'x' title contains 'y'", /unexpected "title"/],
    ["title contains 'x'; drop", /unexpected character/],
    ["'x' in", /expected a term after "in"/],
    ["'x'", /expected "in"/],
    ["and = 'x'", /expected a search term/],
    [`${"(".repeat(40)}starred = true${")".repeat(40)}`, /too deeply nested/],
    [`${"not ".repeat(40)}starred = true`, /too deeply nested/],
    ["x".repeat(4001), /longer than 4000/],
  ])("refuses %j", (query, message) => {
    let error: unknown;
    try {
      driveSearchQuery(query);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(GoogleToolError);
    expect((error as GoogleToolError).kind).toBe("invalid_argument");
    expect((error as Error).message).toMatch(message);
  });
});
