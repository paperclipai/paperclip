import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "../components/ui/tooltip";
import type { AdapterConfigFieldsProps, AdapterConfigSection } from "./types";
import { CodexLocalConfigFields } from "./codex-local/config-fields";
import { ClaudeLocalAdvancedFields } from "./claude-local/config-fields";
import { GeminiLocalConfigFields } from "./gemini-local/config-fields";
import { ProcessConfigFields } from "./process/config-fields";
import { OpenClawGatewayConfigFields } from "./openclaw-gateway/config-fields";
import { HermesGatewayConfigFields } from "./hermes-gateway/config-fields";

function renderSection(
  Component: ComponentType<AdapterConfigFieldsProps>,
  adapterType: string,
  section: AdapterConfigSection,
  config: Record<string, unknown> = {},
) {
  return renderToStaticMarkup(
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
  it("separates provider selection from lifecycle and hides fixed Codex permissions", () => {
    const config = {
      provider: "codex",
      lifecycleMode: "warm",
      idleTimeoutMs: 45000,
    };
    const adapter = renderSection(
      CodexLocalConfigFields,
      "paperclip_runner",
      "adapter",
      config,
    );
    const configuration = renderSection(
      CodexLocalConfigFields,
      "paperclip_runner",
      "configuration",
      config,
    );
    const policy = renderSection(
      CodexLocalConfigFields,
      "paperclip_runner",
      "runPolicy",
      config,
    );
    expect(adapter).toContain("ACPX Claude");
    expect(adapter).not.toContain("Runner lifecycle");
    expect(configuration).not.toContain("Permission mode");
    expect(configuration).not.toContain("Runner lifecycle");
    expect(policy).toContain("Runner lifecycle");
    expect(policy).toContain('value="45000"');
    expect(policy).not.toContain("ACPX Claude");
  });

  it.each([
    ["claude_local", ClaudeLocalAdvancedFields],
    ["codex_local", CodexLocalConfigFields],
    ["gemini_local", GeminiLocalConfigFields],
  ] as const)(
    "separates ACP commands and lifecycle for %s",
    (type, Component) => {
      const config = {
        engine: "acp",
        agentCommand: "saved-command",
        warmHandleIdleMs: 1234,
      };
      expect(renderSection(Component, type, "advanced", config)).toContain(
        'value="saved-command"',
      );
      expect(
        renderSection(Component, type, "configuration", config),
      ).not.toContain("ACP server command");
      const policy = renderSection(Component, type, "runPolicy", config);
      expect(policy).toContain("ACP session mode");
      expect(policy).toContain('value="1234"');
      expect(policy).not.toContain("ACP server command");
    },
  );

  it("keeps process command and arguments under Advanced with saved values", () => {
    const config = { command: "node", args: ["worker.js", "--quiet"] };
    expect(
      renderSection(ProcessConfigFields, "process", "configuration", config),
    ).toBe("");
    const advanced = renderSection(
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
    (type, Component) => {
      const config = { timeoutSec: 37 };
      expect(
        renderSection(Component, type, "configuration", config),
      ).not.toContain('value="37"');
      expect(renderSection(Component, type, "runPolicy", config)).toContain(
        'value="37"',
      );
    },
  );
});
