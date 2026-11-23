// @vitest-environment jsdom
import { sampleHarnesses } from "@/test-support/harness-availability";
import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import {
  api, settings, state, cache, settle, render, renderCurrentParams, container,
} from "./NewAgent.test-support";

describe("Cloud agent harness choices", () => {
  it("offers exactly the released harnesses even with experiments and candidate access", async () => {
    cache.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: true, availableHarnesses: sampleHarnesses } });
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: true, enableOpenAiDot: true, enableMuse: true });
    state.adapters = state.adapters.map((adapter: any) => adapter.type === "paperclip_runner"
      ? { ...adapter, candidateHarnesses: [{ agent: "antigravity", model: "candidate-model" }] }
      : adapter);
    const setupId = "00000000-0000-4000-8000-000000000094";
    state.params = new URLSearchParams({ name: "Atlas", adapterType: "process", setupAgentId: setupId });
    api.get.mockResolvedValue({ id: setupId, companyId: "company-1", name: "Atlas", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, metadata: { setupAdapterPending: true }, pauseReason: "setup", status: "paused" });
    await renderCurrentParams();
    await settle();
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="new-agent-adapter"]')].map(input => input.value).sort()).toEqual([
      "claude_local", "codex_local", "copilot_runtime", "grok_local", "opencode_local",
    ]);
    expect(document.body.textContent).not.toContain("Google Antigravity");
  });

  it.each(["antigravity", "kimi", "pi", "cursor_cloud", "claude_managed", "aws_agentcore", "openai_dot", "muse"])("withholds native %s setup and model controls on direct links", async provider => {
    cache.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: true, availableHarnesses: sampleHarnesses } });
    settings.getExperimental.mockResolvedValue({ enableNativeRunner: true, enableOpenAiDot: true, enableMuse: true });
    await render("paperclip_runner", provider);
    expect(container.textContent).toContain("This adapter is unavailable");
    expect(container.querySelector('[aria-label="Model"]')).toBeNull();
    expect(api.testEnvironment).not.toHaveBeenCalled();
    expect(api.hire).not.toHaveBeenCalled();
  });
});
