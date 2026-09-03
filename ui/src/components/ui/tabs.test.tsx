import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsTrigger, tabsListVariants } from "./tabs";

describe("Tabs mobile tap-targets (<=480px)", () => {
  it("raises the horizontal tabs-list height on mobile", () => {
    // Desktop height stays h-9; mobile gets h-12 so the row clears the 44px min.
    expect(tabsListVariants()).toContain("group-data-[orientation=horizontal]/tabs:h-9");
    expect(tabsListVariants()).toContain(
      "max-sm:group-data-[orientation=horizontal]/tabs:h-12",
    );
  });

  it("gives each trigger a >=44px height on mobile without changing desktop", () => {
    const markup = renderToStaticMarkup(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Overview</TabsTrigger>
          <TabsTrigger value="b">Activity</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    // desktop token preserved, mobile 44px (h-11) added
    expect(markup).toContain("h-(--sz-calc-27)");
    expect(markup).toContain("max-sm:h-11");
  });
});
