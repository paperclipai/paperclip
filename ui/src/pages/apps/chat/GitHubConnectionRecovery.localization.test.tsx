// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n, t } from "@/i18n";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitHubAppRecovery } from "./GitHubConnectionRecovery";

vi.mock("@/components/SetupWizard", () => ({ SetupWizardFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer> }));
let root: Root, host: HTMLDivElement;
beforeEach(async () => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); await i18n.changeLanguage("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await i18n.changeLanguage("en"); vi.unstubAllGlobals(); });
const endpoint: ChatEndpoint = { id: "endpoint-raw", companyId: "company-raw", provider: "github", status: "attention", assignedAgentId: "agent-raw", assignedAgentName: "Agent raw", allowUnlinkedPeople: false, botLabel: "Raw {{APP}} <name>", botExternalId: "123456" };
async function locale(language: string) { await act(async () => { await i18n.changeLanguage(language); }); }
async function render(onConnect: () => Promise<void>, named = true) { await act(async () => root.render(<TooltipProvider><GitHubAppRecovery endpoint={{ ...endpoint, botLabel: named ? endpoint.botLabel : null }} reconnect onConnect={onConnect} onExit={() => {}} /></TooltipProvider>)); }
function button(text: string) { const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(n => n.textContent === text || n.getAttribute("aria-label") === text); expect(node, text).toBeDefined(); return node!; }
async function click(node: HTMLElement) { await act(async () => node.click()); }
async function fill(node: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }

it("keeps the raw App name, local fallback error, ID and PEM draft without reconnecting on locale changes", async () => {
  const connect = vi.fn().mockRejectedValue(null);
  await render(connect);
  await click(button("Reconnect saved App"));
  for (const language of ["ru", "en"]) {
    await locale(language);
    expect(host.textContent).toContain(endpoint.botLabel!);
    expect(host.textContent).toContain(t("oct26Audit.github.reconnectError"));
    expect(connect).toHaveBeenCalledExactlyOnceWith(undefined);
  }
  await click(button("Replace App credentials…"));
  const appId = host.querySelector<HTMLInputElement>("#github-app-id")!, key = host.querySelector<HTMLInputElement>("#github-private-key")!;
  await fill(appId, "987654"); await fill(key, "draft-{{PEM}}");
  for (const language of ["ru", "en", "ru", "en"]) {
    await locale(language);
    expect(host.querySelector("#github-app-id")).toBe(appId); expect(appId.value).toBe("987654");
    expect(host.querySelector("#github-private-key")).toBe(key); expect(key.value).toBe("draft-{{PEM}}");
    expect(host.textContent).toContain(t("oct26Audit.github.invalidKey"));
    expect(host.textContent).toContain(endpoint.botLabel!); expect(connect).toHaveBeenCalledTimes(1);
    expect(button(t("oct26Audit.github.verifyReconnect")).disabled).toBe(true);
  }
});

it("preserves provider diagnostics and the unnamed App's complete grammatical message", async () => {
  const connect = vi.fn().mockRejectedValue(new Error("Provider {{RAW}} <diagnostic>"));
  await render(connect, false); await click(button("Reconnect saved App"));
  await locale("ru");
  expect(host.textContent).toContain("существующего приложения");
  expect(host.textContent).toContain("Provider {{RAW}} <diagnostic>");
  expect(host.textContent).not.toContain("oct26Audit.");
  await locale("en"); expect(host.textContent).toContain("your existing App"); expect(connect).toHaveBeenCalledTimes(1);
});
