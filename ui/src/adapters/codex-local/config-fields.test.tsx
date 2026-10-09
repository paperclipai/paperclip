// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { beforeAll, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { CodexLocalConfigFields } from "./config-fields";

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

describe("Paperclip Runner Codex configuration", () => {
  it("keeps Dot out of the general harness picker and hides that picker for Dot", async () => {
    expect(await renderRunner({ provider: "codex" }, "Harness", true)).not.toContain("OpenAI Dot");
    const dot = await renderRunner({ provider: "openai_dot" });
    expect(dot).not.toContain('aria-label="Harness"');
    expect(dot).toContain("Dot connection");
    expect(dot).toContain("Allow externally billed provider");
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

  it("offers qualified Claude, Cursor, Pi and Copilot", async () => {
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
        { label: "Pi", disabled: false }, { label: "GitHub Copilot", disabled: false },
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
