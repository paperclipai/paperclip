import { describe, expect, it } from "vitest";
import { parseTaskSearch } from "../services/task-search.js";

describe("task search query intent", () => {
  it("keeps negation, short domain terms and quoted filler", () => {
    expect(parseTaskSearch('the API is not "in the UI"').tokens).toEqual(["api", "is", "not", "in the ui"]);
    expect(parseTaskSearch("the and").tokens).toEqual(["the", "and"]);
  });

  it("retains the strictest intent for repeated terms", () => {
    expect(parseTaskSearch('callback "callback"').terms).toEqual([{ text: "callback", quoted: true }]);
  });

  it("normalizes task identifiers without guessing their numbers", () => {
    for (const q of ["PAP-42", "pap42", "PAP 42"]) expect(parseTaskSearch(q).identifierQuery).toBe("pap-42");
    expect(parseTaskSearch("T123-42").identifierQuery).toBe("t123-42");
    expect(parseTaskSearch("PAP-420").identifierQuery).toBe("pap-420");
  });
});
