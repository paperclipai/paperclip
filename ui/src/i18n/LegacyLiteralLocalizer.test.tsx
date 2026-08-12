// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from ".";
import {
  translateLegacyLiteral,
  translateUiLiteral,
  useUiLiteralLocale,
} from "./LegacyLiteralLocalizer";

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

  it("updates literals without resetting component state", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      useUiLiteralLocale();
      const [value, setValue] = useState("unsaved");
      return (
        <button onClick={() => setValue("edited")}>
          {translateUiLiteral("Delete")}: {value}
        </button>
      );
    }

    await act(async () => root.render(<Harness />));
    await act(async () => container.querySelector("button")?.click());
    await act(async () => setLocale("zh-CN"));

    expect(container.textContent).toBe("删除: edited");
    await act(async () => root.unmount());
  });
});
