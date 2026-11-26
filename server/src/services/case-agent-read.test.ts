import { describe, expect, it } from "vitest";
import { caseReadPageSchema, projectAgentCaseRead } from "./case-agent-read.js";

const detail = { id: "case", companyId: "company", workIssueId: "task", phase: "verification", handoffVersion: 4,
  updatedAt: "2026-10-20T00:00:00Z", fields: { total: 6 }, workIssue: { id: "task", status: "in_progress", statusVersion: 7 } };

describe("bounded authorized case read projection", () => {
  it("keeps small cases structured and preserves routing on every large JSON page", () => {
    expect(projectAgentCaseRead(detail, {})).toMatchObject({ fields: { total: 6 }, handoffVersion: 4, workIssue: { statusVersion: 7 }, readPage: { mode: "inline" } });
    const large = { ...detail, summary: "\n\"\\🧾".repeat(8_000), fields: { ["large-key-".repeat(2_000)]: ["\n\"\\🧾".repeat(9_000), { exact: true }] },
      documentRefs: Array.from({ length: 1_000 }, (_, i) => ({ title: `Document ${i}` })) };
    for (const section of ["case", "fields"] as const) {
      let result = projectAgentCaseRead(large, { section, limitBytes: 8192 });
      let text = "";
      for (let pages = 0; ; pages++) {
        expect(pages).toBeLessThan(100);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(24 * 1024);
        expect(result).toMatchObject({ id: detail.id, handoffVersion: 4, phase: "verification", workIssue: { statusVersion: 7 } });
        if (result.readPage.mode !== "json_text") throw new Error("Expected a JSON page");
        text += result.readPage.text;
        if (result.readPage.nextOffsetBytes === null) break;
        result = projectAgentCaseRead(large, { section, limitBytes: 8192, offsetBytes: result.readPage.nextOffsetBytes, snapshot: result.readPage.snapshot });
      }
      expect(JSON.parse(text)).toEqual(section === "case" ? large : large.fields);
    }
  });

  it("rejects mixed snapshots after data or task routing changes", () => {
    const first = projectAgentCaseRead(detail, { section: "fields", limitBytes: 4 });
    const options = { section: "fields", offsetBytes: 4, snapshot: first.readPage.snapshot };
    for (const changed of [{ ...detail, fields: { total: 8 } }, { ...detail, handoffVersion: 5 },
      { ...detail, workIssue: { ...detail.workIssue, statusVersion: 8 } }]) {
      expect(() => projectAgentCaseRead(changed, options)).toThrow("Case changed");
    }
  });

  it("validates continuation bounds and UTF-8 offsets without losing exact characters", () => {
    for (const input of [{ offsetBytes: 1 }, { limitBytes: 8193 }, { limitBytes: 3 }, { snapshot: "forged" }, { section: "secrets" }]) {
      expect(caseReadPageSchema.safeParse(input).success).toBe(false);
    }
    const value = { ...detail, fields: { value: "🧾" } };
    const first = projectAgentCaseRead(value, { section: "fields" });
    const bytes = Buffer.from(JSON.stringify(value.fields));
    const offset = bytes.indexOf(Buffer.from("🧾")) + 1;
    expect(() => projectAgentCaseRead(value, { section: "fields", offsetBytes: offset, snapshot: first.readPage.snapshot })).toThrow("UTF-8 byte offset");
  });

  it.each(["case", "issue"] as const)("pages the complete selected %s document without dropping escaped text or revision identity", sourceKind => {
    const selected = { id: "document", key: "notes", sourceKind, sourceIssueId: sourceKind === "issue" ? "10000000-0000-4000-8000-000000000001" : null,
      title: "Document title", format: "markdown", latestRevisionId: "revision-2", latestRevisionNumber: 2,
      body: "🧾\n\"quoted\" \\ escaped\tend\r\n".repeat(4_000), updatedAt: "2026-10-20T01:00:00Z", sourceTrust: null };
    const options = { section: "document" as const, documentKey: selected.key,
      ...(sourceKind === "issue" ? { documentIssueId: "10000000-0000-4000-8000-000000000001" } : {}) };
    let page = projectAgentCaseRead(detail, options, selected), text = "", offsetBytes = 0;
    for (let count = 0; ; count++) {
      expect(count).toBeLessThan(100);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(20 * 1024);
      expect(page).toMatchObject({ id: detail.id, handoffVersion: 4, phase: "verification", workIssue: { statusVersion: 7 },
        selectedDocument: { id: selected.id, key: selected.key, sourceKind, sourceIssueId: selected.sourceIssueId,
          latestRevisionId: "revision-2", latestRevisionNumber: 2 }, readPage: { mode: "json_text", section: "document", offsetBytes } });
      if (page.readPage.mode !== "json_text") throw new Error("Expected document JSON page");
      expect(Buffer.byteLength(page.readPage.text)).toBeLessThanOrEqual(8192);
      text += page.readPage.text;
      if (page.readPage.nextOffsetBytes === null) {
        expect(Buffer.byteLength(text)).toBe(page.readPage.totalBytes);
        break;
      }
      offsetBytes = page.readPage.nextOffsetBytes;
      page = projectAgentCaseRead(detail, { ...options, offsetBytes, snapshot: page.readPage.snapshot }, selected);
    }
    expect(JSON.parse(text)).toEqual(selected);
    const small = { ...selected, body: "Small exact body 🧾" };
    const smallPage = projectAgentCaseRead(detail, options, small);
    expect(smallPage.readPage).toMatchObject({ mode: "json_text", nextOffsetBytes: null });
    if (smallPage.readPage.mode !== "json_text") throw new Error("Expected document JSON page");
    expect(JSON.parse(smallPage.readPage.text)).toEqual(small);
  });

  it("rejects document continuation after revision, body, document identity, or routing changes", () => {
    const selected = { id: "document", key: "notes", sourceKind: "case" as const, sourceIssueId: null,
      body: "🧾 exact body".repeat(100), latestRevisionId: "revision-1", latestRevisionNumber: 1 };
    const first = projectAgentCaseRead(detail, { section: "document", documentKey: "notes", limitBytes: 64 }, selected);
    const options = { section: "document", documentKey: "notes", offsetBytes: first.readPage.nextOffsetBytes, snapshot: first.readPage.snapshot };
    for (const changed of [{ ...selected, body: `${selected.body}changed` }, { ...selected, id: "replacement" },
      { ...selected, latestRevisionId: "revision-2", latestRevisionNumber: 2 }, { ...selected, title: "Changed title" }]) {
      expect(() => projectAgentCaseRead(detail, options, changed)).toThrow("Case changed");
    }
    expect(() => projectAgentCaseRead({ ...detail, handoffVersion: 5 }, options, selected)).toThrow("Case changed");
    expect(() => projectAgentCaseRead({ ...detail, workIssue: { ...detail.workIssue, statusVersion: 8 } }, options, selected)).toThrow("Case changed");
  });

  it("allows document selectors only with a valid document section and key", () => {
    for (const input of [{ section: "document" }, { documentKey: "notes" }, { section: "fields", documentKey: "notes" },
      { section: "case", documentIssueId: "10000000-0000-4000-8000-000000000001" },
      { section: "document", documentIssueId: "10000000-0000-4000-8000-000000000001" },
      { section: "document", documentKey: "" }, { section: "document", documentKey: "../notes" },
      { section: "document", documentKey: "notes", documentIssueId: "not-an-issue" }]) {
      expect(caseReadPageSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(caseReadPageSchema.safeParse({ section: "document", documentKey: "Legacy.Notes:v1" }).success).toBe(true);
    expect(caseReadPageSchema.safeParse({ section: "document", documentKey: "notes",
      documentIssueId: "10000000-0000-4000-8000-000000000001" }).success).toBe(true);
  });
});
