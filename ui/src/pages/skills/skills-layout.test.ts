import { describe, expect, it } from "vitest";
import { resolveSkillsLayout, withSkillsLayout } from "./skills-layout";

describe("skills layout", () => {
  it("prefers the URL, then the saved choice, then cards", () => {
    expect(resolveSkillsLayout(null, null)).toBe("cards");
    expect(resolveSkillsLayout(null, "list")).toBe("list");
    expect(resolveSkillsLayout("cards", "list")).toBe("cards");
    expect(resolveSkillsLayout("list", null)).toBe("list");
    expect(resolveSkillsLayout("table", "grid")).toBe("cards");
  });

  it("keeps the other page controls when it writes the layout", () => {
    const next = withSkillsLayout(new URLSearchParams("tab=discover&catalog=abc"), "list");
    expect(next.toString()).toBe("tab=discover&catalog=abc&layout=list");
    expect(withSkillsLayout(next, "cards").get("layout")).toBe("cards");
  });
});
