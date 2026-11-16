import { describe, expect, it } from "vitest";

import { visibleFilterOptions, type FilterMenuOption } from "./SearchFilterMenu";

describe("visibleFilterOptions", () => {
  it("scans a few hundred saved names once per search and leaves them unchanged", () => {
    const names = Array.from({ length: 400 }, (_, index) => (index === 12 ? "Review" : `Agent ${index}`));
    let scans = 0;
    const options: FilterMenuOption[] = names.map((name, index) => ({
      value: String(index),
      get label() {
        scans += 1;
        if (scans > names.length * 2) throw new Error("search filter rescanned the option list");
        return name;
      },
      literal: true,
      searchText: name,
    }));

    const matched = visibleFilterOptions(options, "review", "ru");
    expect(matched).toHaveLength(1);
    expect(matched[0]?.value).toBe("12");
    expect(scans).toBe(names.length * 2);
  });

  it("still matches a fixed label by its Russian text", () => {
    const options: FilterMenuOption[] = [{ value: "in_review", label: "In Review" }];
    expect(visibleFilterOptions(options, "проверке", "ru").map((option) => option.value)).toEqual(["in_review"]);
    expect(visibleFilterOptions(options, "проверке", "en")).toEqual([]);
  });
});
