// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { act } from "react";
import type { ReactNode } from "react";

import type { ComponentType } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { TooltipProvider } from "../components/ui/tooltip";
import type { AdapterConfigFieldsProps, AdapterConfigSection } from "./types";
import { CodexLocalConfigFields } from "./codex-local/config-fields";
import { ClaudeLocalAdvancedFields } from "./claude-local/config-fields";
import { GeminiLocalConfigFields } from "./gemini-local/config-fields";
import { ProcessConfigFields } from "./process/config-fields";
import { OpenClawGatewayConfigFields } from "./openclaw-gateway/config-fields";
import { HermesGatewayConfigFields } from "./hermes-gateway/config-fields";

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });

async function renderMarkup(node: ReactNode, expand?: string): Promise<string> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  if (expand) await act(async () => {
    container.querySelector(`[aria-label="${expand}"]`)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return html;
}

async function renderSection(
  Component: ComponentType<AdapterConfigFieldsProps>,
  adapterType: string,
  section: AdapterConfigSection,
  config: Record<string, unknown> = {},
) {
  return renderMarkup(
    <TooltipProvider>
      <Component
        mode="edit"
        isCreate={false}
        adapterType={adapterType}
        section={section}
        values={null}
        set={null}
        config={config}
        eff={(_group, _key, original) => original}
        mark={() => {}}
        models={[]}
        hideInstructionsFile
      />
    </TooltipProvider>,
  );
}

describe("adapter configuration sections", () => {
  it("separates provider selection from lifecycle and hides fixed Codex permissions", async () => {
    const config = {
      provider: "codex",
      lifecycleMode: "warm",
      idleTimeoutMs: 45000,
    };
    const adapter = await renderSection(
      CodexLocalConfigFields,
      "paperclip_runner",
      "adapter",
      config,
    );
    const configuration = await renderSection(
      CodexLocalConfigFields,
      "paperclip_runner",
      "configuration",
      config,
    );
    const policy = await renderSection(
      CodexLocalConfigFields,
      "paperclip_runner",
      "runPolicy",
      config,
    );
    expect(adapter).toContain('aria-label="Harness"');
    expect(adapter).not.toContain("Runner lifecycle");
    expect(configuration).not.toContain("Permission mode");
    expect(configuration).not.toContain("Runner lifecycle");
    expect(policy).toContain("Runner lifecycle");
    expect(policy).toContain('value="45000"');
    expect(policy).not.toContain("ACP agents");
  });

  it("keeps ACP agent admission choices in the adapter section", async () => {
    const config = { provider: "acpx", acpxAgent: "claude" };
    const adapter = await renderSection(CodexLocalConfigFields, "paperclip_runner", "adapter", config);
    const policy = await renderSection(CodexLocalConfigFields, "paperclip_runner", "runPolicy", config);

    expect(adapter).toContain('aria-label="ACP agent"');
    expect(adapter).not.toContain("Runner lifecycle");
    expect(policy).toContain("Runner lifecycle");
    expect(policy).not.toContain("ACP agent");
    expect(policy).not.toContain("qualification pending");
  });

  it.each([
    ["claude_local", ClaudeLocalAdvancedFields],
    ["codex_local", CodexLocalConfigFields],
    ["gemini_local", GeminiLocalConfigFields],
  ] as const)(
    "separates ACP commands and lifecycle for %s",
    async (type, Component) => {
      const config = {
        engine: "acp",
        agentCommand: "saved-command",
        warmHandleIdleMs: 1234,
      };
      expect(await renderSection(Component, type, "advanced", config)).toContain(
        'value="saved-command"',
      );
      expect(
        await renderSection(Component, type, "configuration", config),
      ).not.toContain("ACP server command");
      const policy = await renderSection(Component, type, "runPolicy", config);
      expect(policy).toContain("ACP session mode");
      expect(policy).toContain('value="1234"');
      expect(policy).not.toContain("ACP server command");
    },
  );

  it("keeps process command and arguments under Advanced with saved values", async () => {
    const config = { command: "node", args: ["worker.js", "--quiet"] };
    expect(
      await renderSection(ProcessConfigFields, "process", "configuration", config),
    ).toBe("");
    const advanced = await renderSection(
      ProcessConfigFields,
      "process",
      "advanced",
      config,
    );
    expect(advanced).toContain('value="node"');
    expect(advanced).toContain('value="worker.js, --quiet"');
  });

  it.each([
    ["openclaw_gateway", OpenClawGatewayConfigFields],
    ["hermes_gateway", HermesGatewayConfigFields],
  ] as const)(
    "moves %s timeouts without changing their values",
    async (type, Component) => {
      const config = { timeoutSec: 37 };
      expect(
        await renderSection(Component, type, "configuration", config),
      ).not.toContain('value="37"');
      expect(await renderSection(Component, type, "runPolicy", config)).toContain(
        'value="37"',
      );
    },
  );
});
