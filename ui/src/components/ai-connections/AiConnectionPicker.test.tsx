// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

afterEach(() => { document.body.innerHTML = ""; });

it("does not offer an OpenRouter connection for an incompatible OpenCode model", () => {
  document.body.innerHTML = renderToStaticMarkup(<AiConnectionPicker
    adapterType="opencode_local" model="zai/glm-5" requirement={{ companyId: "company", provider: "openrouter" }}
    connections={[{ id: "router", grantId: "grant", companyId: "company", provider: "openrouter", method: "api_key",
      name: "Shared router", ownership: "shared", status: "connected" }]}
    currentUserId="user" agentId="agent" agentName="Nova" onChange={vi.fn()} onConnect={vi.fn()} />);
  expect(document.body.textContent).not.toContain("Shared router");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Responsible user’s connection"]')!.disabled).toBe(true);
  expect(document.body.textContent).toContain("Incompatible with this harness and model");
});

it("masks a shared connection's account label in session replay", () => {
  document.body.innerHTML = renderToStaticMarkup(<AiConnectionPicker
    requirement={{ companyId: "company", provider: "anthropic" }}
    connections={[{ id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "api_key",
      name: "Shared Claude key", accountLabel: "orla.brisk@example.test", ownership: "shared", status: "connected" }]}
    currentUserId="user" agentId="agent" agentName="Nova" onChange={vi.fn()} onConnect={vi.fn()} />);
  expect(replayLeaks("orla.brisk@example.test")).toEqual({ rendered: true, recorded: false });
});

it("masks the responsible user's default connection name in session replay", () => {
  document.body.innerHTML = renderToStaticMarkup(<AiConnectionPicker
    requirement={{ companyId: "company", provider: "anthropic" }}
    connections={[{ id: "mine", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription",
      name: "Orla's Claude Max", ownership: "personal", ownerUserId: "user", isDefault: true, status: "connected" }]}
    currentUserId="user" agentId="agent" agentName="Nova" onChange={vi.fn()} onConnect={vi.fn()} />);
  expect(replayLeaks("Orla's Claude Max")).toEqual({ rendered: true, recorded: false });
});
