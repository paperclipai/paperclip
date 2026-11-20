import { describe, expect, it } from "vitest";

import { translateActivityVerb } from "./ru-activity-verbs";

describe("translateActivityVerb", () => {
  it("translates tool-use templates and keeps the tool name", () => {
    expect(translateActivityVerb("ru", "used cron on")).toBe("использовал cron у");
    expect(translateActivityVerb("ru", "tested Review on")).toBe("проверил Review у");
    expect(translateActivityVerb("ru", "was allowed to use shell on")).toBe("получил разрешение использовать shell у");
    expect(translateActivityVerb("ru", "was blocked from using shell on")).toBe("не смог использовать shell у");
    expect(translateActivityVerb("ru", "asked to use shell on")).toBe("запросил использование shell у");
    expect(translateActivityVerb("ru", "started a test of shell on")).toBe("начал проверку shell у");
    expect(translateActivityVerb("en", "used cron on")).toBe("used cron on");
  });

  it("returns inherited names unchanged", () => {
    expect(translateActivityVerb("ru", "__proto__")).toBe("__proto__");
    expect(translateActivityVerb("ru", "constructor")).toBe("constructor");
  });
});
