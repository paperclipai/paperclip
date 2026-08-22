import { describe, expect, it } from "vitest";
import { extractPaperclipDelegations, extractPaperclipDisposition } from "./disposition-marker.js";

describe("extractPaperclipDelegations", () => {
  it("parses a single delegation with assignee and priority", () => {
    const out = extractPaperclipDelegations(
      'Routing the site build now.\nPAPERCLIP_DELEGATION: {"title":"Build Site B candidate","description":"Fill intake and run doors","assignee":"Engineer-Terra","priority":"high"}',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "Build Site B candidate", assignee: "Engineer-Terra", priority: "high" });
  });

  it("parses multiple markers up to the cap and tolerates the wrapped form", () => {
    const text = [
      '{"PAPERCLIP_DELEGATION":{"title":"A"}}',
      "PAPERCLIP_DELEGATION {\"title\":\"B\"}",
      'PAPERCLIP_DELEGATION: {"title":"C"}',
      'PAPERCLIP_DELEGATION: {"title":"D — beyond cap"}',
    ].join("\n");
    const out = extractPaperclipDelegations(text);
    expect(out.map((d) => d.title)).toEqual(["A", "B", "C"]);
  });

  it("ignores prose mentions and malformed JSON", () => {
    const out = extractPaperclipDelegations(
      "I will use the PAPERCLIP_DELEGATION marker next time. PAPERCLIP_DELEGATION {not json}",
    );
    expect(out).toHaveLength(0);
  });

  it("does not interfere with disposition extraction on the same text", () => {
    const text = 'PAPERCLIP_DELEGATION: {"title":"Child card"}\nPAPERCLIP_DISPOSITION: {"status":"done"}';
    expect(extractPaperclipDelegations(text)).toHaveLength(1);
    expect(extractPaperclipDisposition(text).disposition?.status).toBe("done");
  });
});
