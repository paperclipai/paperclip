import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { i18n } from "../i18n";
import { PluginLauncherTargetFailure, PluginRenderFailure } from "./PluginFeedback";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("localized plugin-host feedback", () => {
  it("keeps the upstream English error copy", async () => {
    await i18n.changeLanguage("en");
    expect(renderToStaticMarkup(<PluginRenderFailure name="Example" />)).toBe("Example: failed to render");
    expect(renderToStaticMarkup(<PluginLauncherTargetFailure name="Example" target="settings" />)).toBe("Example: could not resolve launcher target &quot;settings&quot;.");
  });

  it("translates whole messages without translating plugin-owned identifiers", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(renderToStaticMarkup(<PluginRenderFailure name="Example Plugin" />)).toBe("Example Plugin：渲染失败");
    expect(renderToStaticMarkup(<PluginLauncherTargetFailure name="Example Plugin" target="settings/main" />)).toBe("Example Plugin：无法解析启动器目标“settings/main”。");
  });

  it("escapes plugin-provided names as React text rather than HTML", async () => {
    await i18n.changeLanguage("zh-CN");
    const html = renderToStaticMarkup(<PluginRenderFailure name={'<script>alert("x")</script>'} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("渲染失败");
  });
});
