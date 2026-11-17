// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

afterEach(() => { document.body.innerHTML = ""; });

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
