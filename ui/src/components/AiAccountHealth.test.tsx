// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { CompanyAiConnectionHealth, CompanyAiHealth } from "@paperclipai/shared";
import { AI_HEALTH_DISMISS_MS } from "../lib/ai-health";
import { AiAccountHealthBar, AiAccountHealthPill } from "./AiAccountHealth";

const healthApi = vi.hoisted(() => ({ health: vi.fn() }));
vi.mock("../api/ai-connections", () => ({ aiConnectionsApi: healthApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const claudeForAll: CompanyAiConnectionHealth = {
  id: "claude-for-all",
  name: "Claude for all",
  provider: "anthropic",
  status: "needs_attention",
  affectedAgentIds: ["forge", "nureview"],
};
const oldOpenai: CompanyAiConnectionHealth = {
  id: "old-openai",
  name: "Old OpenAI",
  provider: "openai",
  status: "revoked",
  affectedAgentIds: ["forge", "archivist"],
};
const brokenClaude: CompanyAiHealth = { connections: [claudeForAll] };
const storageKey = "paperclip:ai-health-dismissal:company-1";

let root: Root;
let container: HTMLDivElement;

async function settle() {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}

async function mount(health: CompanyAiHealth) {
  healthApi.health.mockResolvedValue(health);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => root.render(
    <QueryClientProvider client={client}>
      <AiAccountHealthBar />
      <AiAccountHealthPill />
    </QueryClientProvider>,
  ));
  await settle();
}

async function remount(health: CompanyAiHealth) {
  flushSync(() => root.unmount());
  root = createRoot(container);
  await mount(health);
}

const bar = () => container.querySelector("[data-testid='ai-account-health-bar']");
const pill = () => container.querySelector<HTMLButtonElement>("[data-testid='ai-account-health-pill']");
const hideButton = () => container.querySelector<HTMLButtonElement>("button[aria-label='Hide AI account warning']");
const barLinks = () => Array.from(bar()!.querySelectorAll("a")).map((link) => [link.textContent, link.getAttribute("href")]);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("AiAccountHealthBar", () => {
  it("names the broken account, counts its agents and links to sign in", async () => {
    await mount(brokenClaude);
    expect(bar()?.textContent).toContain("\"Claude for all\" needs sign-in. 2 agents use it.");
    expect(barLinks()).toEqual([["Sign in", "/apps/claude-for-all/permissions"], ["Agents", "/agents/all"]]);
    expect(pill()).toBeNull();
  });

  it("lists several broken accounts and counts each agent once", async () => {
    await mount({ connections: [claudeForAll, oldOpenai] });
    expect(bar()?.textContent).toContain("2 AI accounts need attention: \"Claude for all\", \"Old OpenAI\". 3 agents use them.");
    expect(barLinks()[0]).toEqual(["Open AI accounts", "/apps"]);
  });

  it("stays hidden when nothing is broken", async () => {
    await mount({ connections: [] });
    expect(bar()).toBeNull();
    expect(pill()).toBeNull();
  });

  it("hides behind a pill that persists across reloads and reopens the bar", async () => {
    await mount(brokenClaude);
    flushSync(() => hideButton()!.click());
    expect(bar()).toBeNull();
    expect(pill()?.textContent).toBe("1 AI account needs attention");

    await remount(brokenClaude);
    expect(bar()).toBeNull();
    expect(pill()).not.toBeNull();

    flushSync(() => pill()!.click());
    expect(bar()).not.toBeNull();
    expect(pill()).toBeNull();
  });

  it("comes back when the broken set changes", async () => {
    await mount(brokenClaude);
    flushSync(() => hideButton()!.click());
    await remount({ connections: [claudeForAll, oldOpenai] });
    expect(bar()).not.toBeNull();
    expect(pill()).toBeNull();
  });

  it("shows a hidden account again when it breaks again after recovering", async () => {
    await mount(brokenClaude);
    flushSync(() => hideButton()!.click());
    await remount({ connections: [] });
    expect(localStorage.getItem(storageKey)).toBeNull();
    await remount(brokenClaude);
    expect(bar()).not.toBeNull();
    expect(pill()).toBeNull();
  });

  it("reports a failed check unobtrusively and retries it", async () => {
    healthApi.health.mockRejectedValueOnce(new Error("Network down"));
    await mount(brokenClaude);
    const failure = container.querySelector("[data-testid='ai-account-health-error']");
    expect(failure?.textContent).toContain("Could not check AI account sign-ins.");
    expect(bar()).toBeNull();
    flushSync(() => failure!.querySelector("button")!.click());
    await settle();
    expect(container.querySelector("[data-testid='ai-account-health-error']")).toBeNull();
    expect(bar()).not.toBeNull();
  });

  it("comes back 24 hours after it was hidden", async () => {
    await mount(brokenClaude);
    flushSync(() => hideButton()!.click());
    const stored = JSON.parse(localStorage.getItem(storageKey)!);
    localStorage.setItem(storageKey, JSON.stringify({ ...stored, dismissedAt: Date.now() - AI_HEALTH_DISMISS_MS - 1 }));
    await remount(brokenClaude);
    expect(bar()).not.toBeNull();
    expect(pill()).toBeNull();
  });
});
