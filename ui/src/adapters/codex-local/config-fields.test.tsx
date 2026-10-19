// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { act, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import { beforeAll, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { CodexLocalConfigFields } from "./config-fields";
import { buildCodexRunnerConfig } from "./config-fields";
import { buildPaperclipRunnerConfig } from "@paperclipai/adapter-codex-local/ui";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import { resolveCodexLocalCliPolicy } from "@paperclipai/adapter-codex-local";

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });

async function renderMarkup(node: ReactNode, expand?: string, inspect?: (container: HTMLElement) => void): Promise<string> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>));
  if (expand) await act(async () => {
    container.querySelector(`[aria-label="${expand}"]`)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  inspect?.(container);
  const html = container.innerHTML + Array.from(document.body.children).filter(child => child !== container).map(child => child.outerHTML).join("");
  await act(async () => root.unmount());
  container.remove();
  return html;
}

async function renderRunner(config: Record<string, unknown>, expand?: string, inspectOrDot?: ((container: HTMLElement) => void) | boolean): Promise<string> {
  const openAiDotEnabled = inspectOrDot === true;
  const inspect = typeof inspectOrDot === "function" ? inspectOrDot : undefined;
  return renderMarkup(
    <TooltipProvider>
      <CodexLocalConfigFields
        mode="edit"
        isCreate={false}
        adapterType="paperclip_runner"
        values={null}
        set={null}
        config={config}
        eff={(_group, _field, original) => original}
        mark={() => undefined}
        models={[]}
        hideInstructionsFile
        openAiDotEnabled={openAiDotEnabled}
      />
    </TooltipProvider>,
    expand, inspect,
  );
}

async function selectField(container: HTMLElement, label: string, value: string) {
  const picker = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    picker.focus();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
  await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = document.body.querySelector<HTMLButtonElement>(`[role="listbox"][aria-label="${label}"] [data-value="${value}"]`)!;
  expect(option).not.toBeNull();
  await act(async () => {
    option.click();
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });
}

async function editFields(
  mode: "create" | "edit",
  adapterType: "codex_local" | "paperclip_runner",
  inspect: (container: HTMLElement, saved: () => Record<string, unknown>) => Promise<void>,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let currentConfig: Record<string, unknown> = {
    ...(adapterType === "paperclip_runner" ? { provider: "codex", lifecycleMode: "warm", idleTimeoutMs: 45_000 } : { engine: "acp", mode: "persistent", nonInteractivePermissions: "deny" }),
    env: { CODEX_HOME: { type: "secret_ref", secretId: "codex-account" } },
  };
  let currentValues: CreateConfigValues = {
    ...defaultCreateValues,
    adapterType,
    runner: adapterType === "paperclip_runner" ? "paperclip" : "legacy",
    adapterSchemaValues: { provider: "codex" },
    envBindings: { CODEX_HOME: { type: "secret_ref", secretId: "codex-account" } },
    paperclipRunnerLifecycleMode: "warm",
    paperclipRunnerIdleTimeoutMs: 45_000,
    codexEngine: "acp",
    codexAcpMode: "persistent",
    codexAcpNonInteractivePermissions: "deny",
  };
  function Fixture() {
    const [config, setConfig] = useState(currentConfig);
    const [values, setValues] = useState(currentValues);
    currentConfig = config;
    currentValues = values;
    return <CodexLocalConfigFields mode={mode} isCreate={mode === "create"} adapterType={adapterType}
      values={mode === "create" ? values : null} set={patch => setValues(previous => ({ ...previous, ...patch }))}
      config={config} eff={(_group, _field, original) => original}
      mark={(_group, field, value) => setConfig(previous => ({ ...previous, [field]: value }))}
      models={[]} hideInstructionsFile hideRunnerHarness />;
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><Fixture /></TooltipProvider></QueryClientProvider>));
    await inspect(container, () => mode === "create"
      ? adapterType === "paperclip_runner" ? buildPaperclipRunnerConfig(currentValues) : buildCodexRunnerConfig(currentValues)
      : currentConfig);
    if (mode === "create") {
      expect(currentValues.adapterType).toBe(adapterType);
      expect(currentValues.runner).toBe(adapterType === "paperclip_runner" ? "paperclip" : "legacy");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

describe("Paperclip Runner Codex configuration", () => {
  it.each(["", "--sandbox,read-only"])("shows actual automatic Legacy policy and preserves the explicit toggle (%s)", async (extraArgs) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let saved: typeof defaultCreateValues = { ...defaultCreateValues, adapterType: "codex_local", runner: "auto", extraArgs };
    function Fixture() {
      const [values, setValues] = useState(saved);
      saved = values;
      return <CodexLocalConfigFields mode="create" isCreate adapterType="codex_local" values={values}
        set={(patch) => setValues(current => ({ ...current, ...patch }))} config={{}}
        eff={(_group, _field, original) => original} mark={() => undefined} models={[]} hideInstructionsFile />;
    }
    try {
      await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><Fixture /></TooltipProvider></QueryClientProvider>));
      const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Bypass sandbox"]');
      expect(toggle).toBeDefined();
      expect(toggle?.getAttribute("aria-checked")).toBe(String(resolveCodexLocalCliPolicy(buildCodexRunnerConfig(saved)).bypass));
      await act(async () => toggle!.click());
      const config = buildCodexRunnerConfig(saved);
      expect(saved.runner).toBe("auto");
      expect(config.dangerouslyBypassApprovalsAndSandbox).toBe(extraArgs !== "");
      expect(toggle?.getAttribute("aria-checked")).toBe(String(resolveCodexLocalCliPolicy(config).bypass));
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  it.each([
    {},
    { dangerouslyBypassApprovalsAndSandbox: false, dangerouslyBypassSandbox: true },
    { dangerouslyBypassSandbox: false },
    { extraArgs: ["--sandbox", "read-only"] },
  ])("shows the actual saved Legacy CLI policy while editing %j", async config => {
    await renderMarkup(<TooltipProvider><CodexLocalConfigFields mode="edit" isCreate={false}
      adapterType="codex_local" values={null} set={null} config={config}
      eff={(_group, _field, original) => original} mark={() => undefined} models={[]} hideInstructionsFile />
    </TooltipProvider>, undefined, container => {
      expect(container.querySelector('[aria-label="Bypass sandbox"]')?.getAttribute("aria-checked"))
        .toBe(String(resolveCodexLocalCliPolicy(config).bypass));
    });
  });
  it("edits the legacy execution engine through the shared keyboard picker", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const changes: unknown[][] = [];
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}><TooltipProvider>
      <CodexLocalConfigFields mode="edit" isCreate={false} adapterType="codex_local" values={null} set={null}
        config={{ engine: "acp" }} eff={(_group, _field, original) => original}
        mark={(...change) => { changes.push(change); }} models={[]} hideInstructionsFile />
    </TooltipProvider></QueryClientProvider>));
    const picker = container.querySelector<HTMLButtonElement>('[aria-label="Execution engine"]')!;
    await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const selected = document.body.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')!;
    expect(selected.textContent).toBe("ACP");
    await act(async () => selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("Codex CLI");
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(changes).toEqual([["adapterConfig", "engine", "cli"]]);
    await act(async () => root.unmount());
    container.remove();
  });
  it.each(["create", "edit"] as const)("changes native lifecycle while retaining timeout and account in %s mode", async mode => {
    await editFields(mode, "paperclip_runner", async (container, saved) => {
      expect(container.querySelector('[aria-label="Runner lifecycle"]')?.textContent).toContain("Warm session");
      expect(container.textContent).toContain("Warm idle timeout (ms)");
      const account = saved().env;
      await selectField(container, "Runner lifecycle", "per_turn");
      expect(container.textContent).not.toContain("Warm idle timeout (ms)");
      expect(saved()).toMatchObject({ provider: "codex", lifecycleMode: "per_turn", env: account });
      await selectField(container, "Runner lifecycle", "warm");
      expect(container.textContent).toContain("Warm idle timeout (ms)");
      expect(saved()).toMatchObject({ provider: "codex", lifecycleMode: "warm", idleTimeoutMs: 45_000, env: account });
    });
  });
  it.each(["create", "edit"] as const)("changes Legacy ACP session and permissions without replacing the account in %s mode", async mode => {
    await editFields(mode, "codex_local", async (container, saved) => {
      expect(container.querySelector('[aria-label="ACP session mode"]')?.textContent).toContain("Persistent");
      expect(container.querySelector('[aria-label="ACP non-interactive permissions"]')?.textContent).toContain("Deny");
      const account = saved().env;
      await selectField(container, "ACP session mode", "oneshot");
      await selectField(container, "ACP non-interactive permissions", "fail");
      expect(saved()).toMatchObject({ engine: "acp", mode: "oneshot", nonInteractivePermissions: "fail", env: account });
      await selectField(container, "ACP session mode", "persistent");
      await selectField(container, "ACP non-interactive permissions", "deny");
      expect(saved()).toMatchObject({ engine: "acp", mode: "persistent", nonInteractivePermissions: "deny", env: account });
    });
  });
  it("preserves an unknown native provider instead of presenting it as Codex", async () => {
    const html = await renderRunner({ provider: "future-provider" });
    expect(html).toContain("future-provider");
    expect(html).not.toContain('aria-label="Permission mode"');
  });
  it("keeps Dot out of the general harness picker and hides that picker for Dot", async () => {
    expect(await renderRunner({ provider: "codex" }, "Harness", true)).not.toContain("OpenAI Dot");
    const dot = await renderRunner({ provider: "openai_dot" });
    expect(dot).not.toContain('aria-label="Harness"');
    expect(dot).toContain("Dot connection");
    expect(dot).toContain("Allow externally billed provider");
  });
  it("uses the shared Muse connection and excludes local harness, workspace, and lifecycle fields", async () => {
    const muse = await renderRunner({ provider: "muse" });
    expect(muse).toContain("Muse connection");
    expect(muse).toContain("Allow externally billed provider");
    expect(muse).not.toContain('aria-label="Harness"');
    expect(muse).not.toContain("Runner lifecycle");
    expect(muse).not.toContain("Workspace files and commands");
    expect(muse).not.toContain("Capture raw provider traces");
  });
  it("keeps the general harness picker hidden for an existing Grok Bot", async () => {
    const html = await renderRunner({ provider: "grok_bot" });
    expect(html).not.toContain('aria-label="Harness"');
    expect(html).toContain("Save the Grok Bot agent before connecting it.");
  });
  it.each([
    [undefined, "Full auto (approve all)"],
    ["approve-paperclip", "Automatic Paperclip actions"],
    ["approve-reads", "Allow Paperclip reads"],
    ["deny-all", "Deny all"],
  ])("displays Grok's default or saved permission mode %s", async (acpxPermissionMode, label) => {
    const html = await renderRunner({ provider: "acpx", acpxAgent: "grok", acpxPermissionMode });
    expect(html).toContain('Grok Build');
    expect(html).toContain('aria-label="Permission mode"');
    expect(html).toContain(label);
  });

  it("exposes all qualified provider choices", async () => {
    const html = await renderRunner({ provider: "codex" }, "Harness");

    expect(html).toContain('aria-label="Harness"');
    expect(html).toContain("OpenCode 1.18.34");
    expect(html).toContain('ACP agents');
    expect(html).not.toContain("Permission mode");
    expect(html).not.toContain("Ask when requested");
    expect(html).not.toContain("Ask for untrusted operations");
    expect(html).toContain("Claude Managed");
    expect(html).toContain("AWS AgentCore");
    expect(html).not.toContain("Bypass sandbox");
  });

  it("renders OpenCode's bounded permission modes", async () => {
    const html = await renderRunner({
      provider: "opencode",
      opencodePermissionMode: "allow",
    });

    expect(html).toContain(
      'OpenCode 1.18.34',
    );
    expect(html).toContain("Full auto (allow)");
    expect(html).toContain('aria-label="Permission mode"');
    expect(html).toContain("font-sans");
    expect(html).not.toContain("Ask for untrusted operations");
  });

  it("offers qualified Claude, Cursor and Pi while keeping Copilot disabled", async () => {
    const html = await renderRunner({
      provider: "acpx",
      acpxAgent: "claude",
      acpxPermissionMode: "approve-reads",
    }, "ACP agent");

    expect(html).toContain('ACP agents');
    expect(html).toContain("ACP agent");
    const options = new DOMParser().parseFromString(html, "text/html").querySelectorAll('[role="option"]');
    expect(Array.from(options, option => ({ label: option.textContent?.trim(), disabled: option.hasAttribute("data-disabled") })))
      .toEqual(expect.arrayContaining([
        { label: "Claude", disabled: false }, { label: "Cursor", disabled: false },
        { label: "Pi", disabled: false }, { label: "GitHub Copilot — qualification pending", disabled: true },
      ]));
    expect(html).not.toContain("Codex via ACPX");
    expect(html).not.toContain("ACPX Codex");
    expect(html).not.toContain("Pi via ACPX");
    expect(html).toContain("Allow Paperclip reads");
  });

  it.each([undefined, "agent", "plan", "ask"])("displays saved Cursor mode %s", async acpxSessionMode => {
    const selected = acpxSessionMode ?? "agent";
    await renderRunner({ provider: "acpx", acpxAgent: "cursor", acpxSessionMode }, undefined, container => {
      const modes = container.querySelectorAll('[aria-label="Cursor mode"]');
      expect(modes).toHaveLength(1);
      expect((modes[0] as HTMLSelectElement).value).toBe(selected);
    });
  });

  it.each([undefined, "off", "low", "high", "max"])("displays saved Pi thinking level %s", async piThinkingLevel => {
    await renderRunner({ provider: "acpx", acpxAgent: "pi", piThinkingLevel }, undefined, container => {
      const mode = container.querySelector('[aria-label="Pi thinking level"]');
      expect((mode as HTMLSelectElement).value).toBe(piThinkingLevel ?? "low");
    });
  });
  it("shows unsupported saved Pi level without aliasing it", async () => {
    expect(await renderRunner({ provider: "acpx", acpxAgent: "pi", piThinkingLevel: "medium" })).toContain("Unsupported saved thinking level");
  });
  it.each(["claude", "copilot", "pi"])("does not expose Cursor mode for %s", async acpxAgent => {
    expect(await renderRunner({ provider: "acpx", acpxAgent })).not.toContain('aria-label="Cursor mode"');
  });

  it("falls back to the fail-closed Codex permission mode", async () => {
    const html = await renderRunner({ codexPermissionMode: "unrestricted" });

    expect(html).toContain("Unsupported saved mode — select a qualified mode");
    expect(html).toContain("cannot start or recover a Paperclip Runner run");
    expect(html).toContain("Select Automatic (isolated) to remediate it");
    expect(html).not.toContain("Full auto (never ask)");
  });

  it("shows a bounded idle timeout only for warm sessions", async () => {
    const warmHtml = await renderRunner({
      lifecycleMode: "warm",
      idleTimeoutMs: 45_000,
    });
    const turnHtml = await renderRunner({
      lifecycleMode: "per_turn",
      idleTimeoutMs: 45_000,
    });

    expect(warmHtml).toContain("Warm idle timeout (ms)");
    expect(warmHtml).toContain('value="45000"');
    expect(warmHtml).toContain('max="86400000"');
    expect(turnHtml).not.toContain("Warm idle timeout (ms)");
  });
});
