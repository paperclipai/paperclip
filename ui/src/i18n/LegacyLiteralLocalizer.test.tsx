// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from ".";
import { translateLegacyLiteral, translateUiLiteral } from "./LegacyLiteralLocalizer";

afterEach(async () => setLocale("en"));

describe("static UI literal localization", () => {
  it("translates exact literals and preserves dynamic template values", () => {
    expect(translateLegacyLiteral("Advanced Permissions")).toBe("高级权限");
    expect(translateLegacyLiteral("Acting on behalf of Alice")).toBe("代表 Alice 行事");
    expect(translateLegacyLiteral("收藏 Chief of staff")).toBeNull();
  });

  it("only translates in the Chinese locale", async () => {
    await setLocale("zh-CN");
    expect(translateUiLiteral("Delete")).toBe("删除");
    expect(translateUiLiteral("A user-authored name")).toBe("A user-authored name");

    await setLocale("en");
    expect(translateUiLiteral("Delete")).toBe("Delete");
  });
});
