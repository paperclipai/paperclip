import { describe, expect, it } from "vitest";
import type { Company } from "@paperclipai/shared";
import { sortCompaniesByOrder } from "./useCompanyOrder";

function company(id: string, name: string): Company {
  return {
    id,
    name,
    issuePrefix: id.toUpperCase(),
    status: "active",
  } as Company;
}

describe("sortCompaniesByOrder", () => {
  it("returns companies in alphabetical order when no saved order is provided", () => {
    const companies = [
      company("c", "Strata"),
      company("a", "Acme Labs"),
      company("b", "anachronist wiki"),
    ];

    const sorted = sortCompaniesByOrder(companies, []);
    expect(sorted.map((entry) => entry.name)).toEqual([
      "Acme Labs",
      "anachronist wiki",
      "Strata",
    ]);
  });

  it("preserves a saved custom order ahead of unsaved companies", () => {
    const companies = [
      company("a", "Acme Labs"),
      company("b", "Brillo"),
      company("c", "Crater"),
    ];

    const sorted = sortCompaniesByOrder(companies, ["c", "a"]);
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("returns an empty array when there are no companies", () => {
    expect(sortCompaniesByOrder([], [])).toEqual([]);
  });
});
