import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { DesignSandboxProvider } from "./DesignSandboxContext";

vi.mock("@/components/ui/flyout", () => ({ FlyoutAppearanceProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/ui/avatar-initials", () => ({ AvatarInitialProvider: ({ children }: { children: React.ReactNode }) => children }));

afterEach(async () => { await i18n.changeLanguage("en"); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("renders complete localized experiment toggle labels without changing saved values", async () => {
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_PAPERCLIP_DESIGN_SANDBOX", "true");
  let stored = "on";
  vi.stubGlobal("localStorage", { getItem: () => stored });
  await i18n.changeLanguage("zh-CN");
  expect(renderToStaticMarkup(<DesignSandboxProvider>content</DesignSandboxProvider>)).toContain("设计提案：已开启");
  stored = "off";
  expect(renderToStaticMarkup(<DesignSandboxProvider>content</DesignSandboxProvider>)).toContain("设计提案：已关闭");
  expect(stored).toBe("off");
  await i18n.changeLanguage("en");
  expect(renderToStaticMarkup(<DesignSandboxProvider>content</DesignSandboxProvider>)).toContain("Design proposals: Off");
});
