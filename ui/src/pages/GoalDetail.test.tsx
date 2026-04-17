// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, setCurrentLocale } from "@/i18n/runtime";
import { GoalPropertiesToggleButton } from "./GoalDetail";

describe("GoalPropertiesToggleButton", () => {
  it("shows the reopen control when the properties panel is hidden", () => {
    setCurrentLocale("zh-CN");
    const html = renderToStaticMarkup(
      <I18nProvider>
        <GoalPropertiesToggleButton panelVisible={false} onShowProperties={() => {}} />
      </I18nProvider>,
    );

    expect(html).toContain('title="显示属性"');
    expect(html).toContain("opacity-100");
  });

  it("collapses the reopen control while the properties panel is already visible", () => {
    setCurrentLocale("zh-CN");
    const html = renderToStaticMarkup(
      <I18nProvider>
        <GoalPropertiesToggleButton panelVisible onShowProperties={() => {}} />
      </I18nProvider>,
    );

    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("w-0");
  });
});
