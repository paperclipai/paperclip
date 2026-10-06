// @vitest-environment jsdom
import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import type { GatewayAppRow } from "../gateway-helpers";
import { AppsToolsPanel } from "./AppsToolsPanel";
import { OverviewPanel } from "./OverviewPanel";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), copy: vi.fn() }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.toast }) }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("gateway panel tool counts", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove();
    await i18n.changeLanguage("en"); vi.clearAllMocks();
  });

  it.each([[1, "1 tool", "1 инструмент"], [2, "2 tools", "2 инструмента"], [5, "5 tools", "5 инструментов"], [21, "21 tools", "21 инструмент"]] as const)(
    "updates both panels for %s tools without altering gateway data, routes or controls",
    async (count, en, ru) => {
      const apps = [{ application: { id: "raw-application-id", name: "Custom English App" }, connection: null,
        toolCount: count, needsAttention: true, attentionReason: "Provider-owned English error" }] as GatewayAppRow[];
      const gateway = { id: "raw-gateway-id", displaySlug: "raw-slug", status: "active", endpointPath: "/mcp/gateways/raw-gateway-id",
        tokens: [], contextScopeType: "none", contextScopeId: null, agentId: null, projectId: null } as unknown as ToolMcpGatewayWithTokens;
      const before = JSON.stringify({ apps, gateway });
      const onToggle = vi.fn();
      await act(async () => root.render(<>
        <section data-panel="tools"><AppsToolsPanel apps={apps} profile={undefined} /></section>
        <section data-panel="overview"><OverviewPanel gateway={gateway} profile={undefined} apps={apps}
          agentNames={new Map()} projectNames={new Map()} toggleDisabled={false} onToggle={onToggle} /></section>
      </>));
      const toolCell = host.querySelector('[data-panel="tools"] tbody td:nth-child(2)')!;
      const overviewRow = host.querySelector('[data-panel="overview"] li')!;
      const snippet = host.querySelector("pre")!;
      const rawSnippet = snippet.textContent;
      const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
      for (const [locale, expected] of [["en", en], ["ru", ru], ["en", en]] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        expect(host.querySelector('[data-panel="tools"] tbody td:nth-child(2)')).toBe(toolCell);
        expect(toolCell.textContent?.trim()).toBe(expected);
        expect(overviewRow.textContent).toContain(`${expected} · Provider-owned English error`);
        expect(host.querySelectorAll('a[href="/apps/app/raw-application-id/permissions"]')).toHaveLength(3);
        expect(overviewRow.querySelector("a")?.textContent).toBe("Custom English App");
        expect(snippet.textContent).toBe(rawSnippet);
        expect(snippet.textContent).toContain('"paperclip-raw-slug"');
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        expect(JSON.stringify({ apps, gateway })).toBe(before);
        expect(onToggle).not.toHaveBeenCalled();
        expect(mocks.copy).not.toHaveBeenCalled();
      }
      await act(async () => toggle.click());
      expect(onToggle).toHaveBeenCalledTimes(1);
    },
  );
});
