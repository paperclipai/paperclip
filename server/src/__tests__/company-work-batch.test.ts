import { describe, expect, it } from "vitest";
import { takeCompanyWorkBatch } from "../services/company-work-batch.js";

describe("company work batch", () => {
  it("shares capacity while preserving the owner's order within each company", () => {
    const entries = [
      { companyId: "a", id: "a-oldest" }, { companyId: "a", id: "a-next" },
      { companyId: "a", id: "a-later" }, { companyId: "b", id: "b-due" },
    ];
    expect(takeCompanyWorkBatch(entries, 3)).toEqual({
      entries: [entries[0], entries[3], entries[1]], lastCompany: "a",
    });
  });
  it("rotates between batches when more companies are due than fit in one batch", () => {
    const entries = ["a", "b", "c", "d"].flatMap(companyId => [
      { companyId, id: `${companyId}-first` }, { companyId, id: `${companyId}-second` },
    ]);
    const first = takeCompanyWorkBatch(entries, 2);
    const remaining = entries.filter(entry => !first.entries.includes(entry));
    const second = takeCompanyWorkBatch(remaining, 2, first.lastCompany);
    expect([...first.entries, ...second.entries].map(entry => entry.companyId)).toEqual(["a", "b", "c", "d"]);
    expect(takeCompanyWorkBatch(remaining, 1, "z").entries[0].companyId).toBe("a");
  });
  it("finishes an empty or exhausted batch without inventing work", () => {
    expect(takeCompanyWorkBatch([], 25, "gone")).toEqual({ entries: [], lastCompany: "gone" });
    const entry = { companyId: "only" };
    expect(takeCompanyWorkBatch([entry], 25).entries).toEqual([entry]);
  });
});
