// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { AdapterTypeDropdown } from "./AgentConfigForm";
import { TooltipProvider } from "./ui/tooltip";

describe("shared Cloud harness dropdown", () => {
  it.each([false, true])("filters Cloud choices without exposing experiments (cloud=%s)", async cloud => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient();
    client.setQueryData(queryKeys.health, { status: "ok", cloud: cloud ? { managed: true } : null });
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider>
        <AdapterTypeDropdown value="codex_local" onChange={() => {}} disabledTypes={new Set()}
          openAiDotEnabled museEnabled nativeRunnerEnabled />
      </TooltipProvider></QueryClientProvider>));
      await act(async () => container.querySelector('[aria-label="Harness"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
      const choices = [...document.querySelectorAll('[role="option"]')].map(option => option.getAttribute("data-value"));
      if (cloud) {
        expect(choices.sort()).toEqual(["claude_local", "codex_local", "grok_local", "opencode_local", "paperclip_runner"]);
      } else {
        expect(choices).toContain("gemini_local");
        expect(choices).toContain("openai_dot");
        expect(choices).toContain("muse");
      }
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  });
});
