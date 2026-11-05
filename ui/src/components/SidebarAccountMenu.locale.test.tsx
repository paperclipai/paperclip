import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { builtinEnvironments } from "vitest/runtime";

const closeSidebar = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: null }) }));
vi.mock("@/hooks/useCloudInstance", () => ({ useCloudInstance: () => null }));
vi.mock("@/hooks/useCloudInviteUrl", () => ({ useCloudInviteUrl: () => null }));
vi.mock("@/hooks/useCompanyInviteAccess", () => ({ useCanInviteCompanyMembers: () => false }));
vi.mock("@/hooks/useHiddenSettings", () => ({ useHiddenSettings: () => ({ hidden: {}, loaded: true }) }));
vi.mock("@/hooks/useSignOut", () => ({ useSignOut: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/useStagingCommit", () => ({ useStagingCommit: () => null }));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: true, setSidebarOpen: closeSidebar, collapsed: false, peeking: false }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("./ThemeToggle", () => ({ ThemeToggle: () => <button type="button">Theme</button> }));
vi.mock("./SidebarServerInfo", () => ({ SidebarServerInfo: () => null }));

let teardown: (() => Promise<void> | void) | undefined;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  if (typeof document === "undefined") {
    const environment = await builtinEnvironments.jsdom.setup(globalThis, {});
    teardown = async () => { await environment.teardown(globalThis); };
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CustomEvent", window.CustomEvent);
});

beforeEach(async () => {
  closeSidebar.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  const { i18n } = await import("../i18n");
  await i18n.changeLanguage("en");
  localStorage.clear();
});

afterEach(async () => {
  await act(() => root.unmount());
  await new Promise((resolve) => setTimeout(resolve, 0));
  container.remove();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await teardown?.();
});

describe("sidebar account locale selection", () => {
  it.each(["local_trusted", "authenticated"] as const)("switches in the %s account menu without closing navigation", async (deploymentMode) => {
    const { SidebarAccountMenu } = await import("./SidebarAccountMenu");
    const { TooltipProvider } = await import("./ui/tooltip");
    const onOpenChange = vi.fn();
    await act(() => root.render(
      <TooltipProvider>
        <SidebarAccountMenu open onOpenChange={onOpenChange} deploymentMode={deploymentMode} />
      </TooltipProvider>,
    ));
    const select = document.body.querySelector("select");
    expect(select).not.toBeNull();
    expect(select!.labels?.[0]?.textContent).toContain("Language");
    select!.value = "zh-CN";
    await act(() => select!.dispatchEvent(new Event("change", { bubbles: true })));
    expect(localStorage.getItem("paperclip.locale")).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(select!.labels?.[0]?.querySelector("span")?.textContent).toBe("语言");
    expect(document.body.textContent).toContain("设置");
    expect(document.body.textContent).toContain("文档");
    expect(document.body.querySelector('[aria-label="打开账号菜单"]')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(closeSidebar).not.toHaveBeenCalled();
    expect(document.body.contains(select)).toBe(true);
  });
});
