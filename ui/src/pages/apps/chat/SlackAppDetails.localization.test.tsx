import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { SlackAppDetails, SlackSetupAdvanced } from "./SlackAppDetails";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("localizes collapsed Slack settings and schema validation without changing configuration values", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(renderToStaticMarkup(<SlackSetupAdvanced>child</SlackSetupAdvanced>)).toContain("高级");
  const value = { appName: "", botName: "my-bot", command: "/paperclip" };
  const markup = renderToStaticMarkup(<TooltipProvider><SlackAppDetails value={value} readOnly={false} onChange={() => {}} onBlur={() => {}} /></TooltipProvider>);
  expect(markup).toContain("请输入 Slack 应用名称。");
  expect(markup).toContain("my-bot");
  expect(markup).toContain("/paperclip");
  expect(value).toEqual({ appName: "", botName: "my-bot", command: "/paperclip" });
});
