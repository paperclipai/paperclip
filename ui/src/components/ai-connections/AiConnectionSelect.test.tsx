// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiConnectionSelect } from "./AiConnectionSelect";
import { replayLeaks } from "@/lib/analytics/replay-recording.test-utils";

vi.mock("@/pages/apps/AppLogo", () => ({ AppLogo: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });

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
