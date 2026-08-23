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

describe("bare string-valued marker (gemini/antigravity, 2026-08-23)", () => {
  it("captures the fenced wrapped-string form the antigravity lane emits", () => {
    // Verbatim shape from run f54af589 (2026-08-22): the marker as a JSON key
    // with a bare STRING value inside a fenced block. The object-only scan
    // found no "{" after the marker and discarded it.
    const text = [
      "I have left a comment on the review issue and closed it as done.",
      "",
      "```json",
      '{"PAPERCLIP_DISPOSITION": "done"}',
      "```",
    ].join("\n");
    const out = extractPaperclipDisposition(text);
    expect(out.disposition?.status).toBe("done");
    expect(out.disposition?.hasBlocker).toBe(false);
    expect(out.cleanedText).not.toContain("PAPERCLIP_DISPOSITION");
  });

  it("captures the unfenced wrapped-string form", () => {
    const text = 'Marked the follow-up in the Paperclip API.\n\n{"PAPERCLIP_DISPOSITION": "blocked"}\n';
    expect(extractPaperclipDisposition(text).disposition?.status).toBe("blocked");
  });

  it("captures a bare colon-and-status line", () => {
    expect(extractPaperclipDisposition("Work parked.\nPAPERCLIP_DISPOSITION: in_review").disposition?.status)
      .toBe("in_review");
  });

  it("still prefers the object form and lets the last marker win", () => {
    const text = '{"PAPERCLIP_DISPOSITION": "done"}\nPAPERCLIP_DISPOSITION: {"status":"blocked","blocker":"needs key"}';
    const out = extractPaperclipDisposition(text);
    expect(out.disposition?.status).toBe("blocked");
    expect(out.disposition?.blocker).toBe("needs key");
  });

  it("rejects a non-status string so prose can never move issue state", () => {
    expect(extractPaperclipDisposition('{"PAPERCLIP_DISPOSITION": "probably fine"}').disposition).toBeNull();
    expect(extractPaperclipDisposition("Remember to emit PAPERCLIP_DISPOSITION when finishing.").disposition)
      .toBeNull();
  });
});
