// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiConnectionSelect } from "./AiConnectionSelect";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";
import type { ComponentProps } from "react";

vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });

async function openConnections(props: Partial<ComponentProps<typeof AiConnectionSelect>> = {}) {
  flushSync(() => root.render(<AiConnectionSelect requirement={{ companyId: "company", provider: "openrouter" }}
    connections={[]} currentUserId="user" agentId="agent" agentName="Nova" adapterType="opencode_local"
    onChange={vi.fn()} onConnect={vi.fn()} {...props} />));
  const trigger = container.querySelector<HTMLElement>('[role="combobox"][aria-label="Connection"]')!;
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync(() => {});
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

it("filters OpenRouter accounts against the chosen OpenCode model", async () => {
  const options = await openConnections({ model: "zai/glm-5", connections: [{
    id: "router", grantId: "grant", companyId: "company", provider: "openrouter", method: "api_key",
    name: "Router account", ownership: "shared", status: "connected",
  }] });
  expect(options.some(option => option.textContent?.includes("Router account"))).toBe(false);
  expect(options.some(option => option.textContent?.includes("Responsible user"))).toBe(false);
});

it("disables the old subscription after switching harnesses", async () => {
  const props = {
    requirement: { companyId: "company", provider: "anthropic" as const },
    connections: [{ id: "claude", grantId: "grant", companyId: "company", provider: "anthropic" as const,
      method: "subscription" as const, name: "Claude subscription", ownership: "shared" as const, status: "connected" as const }],
    value: { mode: "shared" as const, provider: "anthropic" as const, method: "subscription" as const, connectionId: "claude", grantId: "grant" },
    currentUserId: "user", agentId: "agent", agentName: "Nova", onChange: vi.fn(), onConnect: vi.fn(),
  };
  flushSync(() => root.render(<AiConnectionSelect {...props} adapterType="claude_local" />));
  const options = await openConnections({ ...props, adapterType: "opencode_local" });
  const oldAccount = options.find(option => option.textContent?.includes("Claude subscription"));
  expect(oldAccount?.getAttribute("aria-disabled")).toBe("true");
  expect(oldAccount?.textContent).toContain("Incompatible with this harness and model");
  flushSync(() => oldAccount!.click());
  expect(props.onChange).not.toHaveBeenCalled();
});

it.each(["anthropic", "openai", "google", "openrouter"] as const)("offers %s API accounts for Pi before a model is chosen", async provider => {
  const options = await openConnections({ adapterType: "pi_local", connections: [{
    id: "key", grantId: "grant", companyId: "company", provider, method: "api_key",
    name: "Supported API account", ownership: "shared", status: "connected",
  }] });
  expect(options.some(option => option.textContent?.includes("Supported API account"))).toBe(true);
});

it("uses the actual default account's sign-in method for harness compatibility", async () => {
  const options = await openConnections({ adapterType: "gemini_local", requirement: { companyId: "company", provider: "google" }, connections: [{
    id: "google", grantId: "grant", companyId: "company", provider: "google", method: "subscription",
    name: "Antigravity subscription", ownership: "personal", ownerUserId: "user", isDefault: true, status: "connected",
  }] });
  expect(options.some(option => option.textContent?.includes("Responsible user"))).toBe(false);
});

it("puts the connect action beside the missing-default message", () => {
  const connect = vi.fn();
  flushSync(() => root.render(<AiConnectionSelect requirement={{ companyId: "company", provider: "anthropic" }}
    connections={[]} currentUserId="user" agentId="agent" agentName="Nova" adapterType="claude_local"
    value={{ provider: "anthropic", method: "subscription", mode: "responsible_user" }} onChange={vi.fn()} onConnect={connect} />));
  const alert = container.querySelector('[role="alert"]')!;
  const button = alert.querySelector<HTMLButtonElement>("button");
  expect(button?.textContent).toBe("Connect an account");
  flushSync(() => button!.click());
  expect(connect).toHaveBeenCalledOnce();
});

it("masks the selected connection in the trigger and the account labels in the open list", async () => {
  const connections = [
    { id: "selected", grantId: "selected-grant", companyId: "company", provider: "anthropic" as const, method: "api_key" as const,
      name: "Claude key", accountLabel: "wren.halloway@example.test", ownership: "shared" as const, status: "connected" as const },
    { id: "other", grantId: "other-grant", companyId: "company", provider: "anthropic" as const, method: "api_key" as const,
      name: "Claude backup", accountLabel: "ivo.castellan@example.test", ownership: "shared" as const, status: "connected" as const },
  ];
  flushSync(() => root.render(<AiConnectionSelect requirement={{ companyId: "company", provider: "anthropic" }}
    connections={connections} currentUserId="user" agentId="agent" agentName="Nova" adapterType="claude_local"
    value={{ provider: "anthropic", method: "api_key", mode: "shared", connectionId: "selected", grantId: "selected-grant" }}
    onChange={vi.fn()} onConnect={vi.fn()} />));
  const trigger = container.querySelector<HTMLElement>('[role="combobox"][aria-label="Connection"]')!;
  expect(replayLeaks("wren.halloway@example.test", trigger)).toEqual({ rendered: true, recorded: false });
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync(() => {});
  expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  expect(replayLeaks("ivo.castellan@example.test", document.body)).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("wren.halloway@example.test", document.body)).toEqual({ rendered: true, recorded: false });
  expect(replayLeaks("Connect an account", document.body)).toEqual({ rendered: true, recorded: false });
});
