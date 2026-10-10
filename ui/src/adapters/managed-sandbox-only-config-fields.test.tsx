// @vitest-environment jsdom

import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClaudeLocalConfigFields, ClaudeLocalAdvancedFields } from "./claude-local/config-fields";
import { CodexLocalConfigFields } from "./codex-local/config-fields";
import { GeminiLocalConfigFields } from "./gemini-local/config-fields";
import type { AdapterConfigFieldsProps } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Under `enableManagedSandboxOnly` every agent runs in the platform-managed
 * environment. The form resolves that policy once and passes it to every
 * adapter, which must then drop each host filesystem path field and each
 * execution-engine choice while keeping its behavior toggles.
 */
const ACP_CONFIG = {
  engine: "acp",
  agentCommand: "vendor-acp",
  stateDir: "/srv/agents/cody/acp-state",
  instructionsFilePath: "/srv/agents/cody/AGENTS.md",
};

function renderFields(
  Component: ComponentType<AdapterConfigFieldsProps>,
  overrides: Partial<AdapterConfigFieldsProps> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const props: AdapterConfigFieldsProps = {
    mode: "edit",
    isCreate: false,
    adapterType: "codex_local",
    values: null,
    set: null,
    config: ACP_CONFIG,
    eff: (_group, _field, original) => original,
    mark: vi.fn(),
    models: [],
    ...overrides,
  };

  act(() => {
    root.render(
      <TooltipProvider>
        <Component {...props} />
      </TooltipProvider>,
    );
  });

  return { container, root };
}

function fieldLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll("label")).map((label) => label.textContent?.trim() ?? "");
}

function choosePathButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === "Choose",
  );
}

describe("adapter config fields under the managed-sandbox-only policy", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("renders the Claude execution engine and ACP paths when the policy is off", () => {
    const result = renderFields(ClaudeLocalAdvancedFields, { adapterType: "claude_local" });
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).toContain("Execution engine");
    expect(labels).toContain("ACP server command");
    expect(labels).toContain("ACP state directory");
    expect(choosePathButtons(result.container)).toHaveLength(1);
  });

  it("drops the Claude execution engine and ACP paths when the policy is on", () => {
    const result = renderFields(ClaudeLocalAdvancedFields, {
      adapterType: "claude_local",
      managedSandboxOnly: true,
    });
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).not.toContain("Execution engine");
    expect(labels).not.toContain("ACP server command");
    expect(labels).not.toContain("ACP state directory");
    expect(choosePathButtons(result.container)).toHaveLength(0);
    expect(result.container.textContent).not.toContain("/srv/agents/cody/acp-state");
    // The non-path ACP controls describe run behavior, not the host, so they stay.
    expect(labels).toContain("ACP session mode");
    expect(labels).toContain("ACP non-interactive permissions");
  });

  it("drops the Claude instructions-file path once the form resolves the gate", () => {
    const visible = renderFields(ClaudeLocalConfigFields, { adapterType: "claude_local" });
    roots.push(visible.root);
    expect(fieldLabels(visible.container)).toContain("Agent instructions file");

    // The form resolves `hideInstructionsFile || managedSandboxOnly` once, so
    // every adapter hides the path with no per-adapter branch.
    const hidden = renderFields(ClaudeLocalConfigFields, {
      adapterType: "claude_local",
      hideInstructionsFile: true,
      managedSandboxOnly: true,
    });
    roots.push(hidden.root);
    expect(fieldLabels(hidden.container)).not.toContain("Agent instructions file");
    expect(choosePathButtons(hidden.container)).toHaveLength(0);
  });

  it("renders the Codex execution engine and paths when the policy is off", () => {
    const result = renderFields(CodexLocalConfigFields);
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).toContain("Execution engine");
    expect(labels).toContain("ACP server command");
    expect(labels).toContain("ACP state directory");
    expect(labels).toContain("Agent instructions file");
    expect(choosePathButtons(result.container).length).toBeGreaterThan(0);
  });

  it("drops the Codex execution engine and paths when the policy is on", () => {
    const result = renderFields(CodexLocalConfigFields, {
      managedSandboxOnly: true,
      hideInstructionsFile: true,
    });
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).not.toContain("Execution engine");
    expect(labels).not.toContain("ACP server command");
    expect(labels).not.toContain("ACP state directory");
    expect(labels).not.toContain("Agent instructions file");
    expect(choosePathButtons(result.container)).toHaveLength(0);
    expect(result.container.textContent).not.toContain("/srv/agents/cody/acp-state");
    // Codex behavior toggles are not host paths, so the policy keeps them.
    expect(result.container.textContent).toContain("Fast mode");
  });

  it("renders the Gemini execution engine and paths when the policy is off", () => {
    const result = renderFields(GeminiLocalConfigFields, { adapterType: "gemini_local" });
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).toContain("Execution engine");
    expect(labels).toContain("ACP server command");
    expect(labels).toContain("ACP state directory");
    expect(labels).toContain("Agent instructions file");
  });

  it("drops the Gemini execution engine and paths when the policy is on", () => {
    const result = renderFields(GeminiLocalConfigFields, {
      adapterType: "gemini_local",
      managedSandboxOnly: true,
      hideInstructionsFile: true,
    });
    roots.push(result.root);

    const labels = fieldLabels(result.container);
    expect(labels).not.toContain("Execution engine");
    expect(labels).not.toContain("ACP server command");
    expect(labels).not.toContain("ACP state directory");
    expect(labels).not.toContain("Agent instructions file");
    expect(choosePathButtons(result.container)).toHaveLength(0);
    expect(labels).toContain("ACP session mode");
  });
});
