import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { CodexLocalConfigFields } from "./config-fields";

function renderRunner(config: Record<string, unknown>): string {
  return renderToStaticMarkup(
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
      />
    </TooltipProvider>,
  );
}

describe("Paperclip Runner Codex configuration", () => {
  it.each([
    [undefined, "Full auto (approve all)"],
    ["approve-paperclip", "Automatic Paperclip actions"],
    ["approve-reads", "Allow Paperclip reads"],
    ["deny-all", "Deny all"],
  ])("displays Grok's default or saved permission mode %s", (acpxPermissionMode, label) => {
    const html = renderRunner({ provider: "acpx", acpxAgent: "grok", acpxPermissionMode });
    expect(html).toContain('<option value="grok" selected="">Grok Build</option>');
    expect(html).toContain('aria-label="Permission mode"');
    expect(html).toContain(label);
  });

  it("exposes all qualified provider choices", () => {
    const html = renderRunner({ provider: "codex" });

    expect(html).toContain('<option value="codex" selected="">Codex</option>');
    expect(html).toContain("OpenCode 1.18.32");
    expect(html).toContain('<option value="acpx">ACP agents</option>');
    expect(html).not.toContain("Permission mode");
    expect(html).not.toContain("Ask when requested");
    expect(html).not.toContain("Ask for untrusted operations");
    expect(html).toContain("Claude Managed");
    expect(html).toContain("AWS AgentCore");
    expect(html).not.toContain("Bypass sandbox");
  });

  it("renders OpenCode's bounded permission modes", () => {
    const html = renderRunner({
      provider: "opencode",
      opencodePermissionMode: "allow",
    });

    expect(html).toContain(
      '<option value="opencode" selected="">OpenCode 1.18.32</option>',
    );
    expect(html).toContain("Full auto (allow)");
    expect(html).toContain('aria-label="Permission mode"');
    expect(html).toContain("font-sans");
    expect(html).not.toContain("Ask for untrusted operations");
  });

  it("offers qualified Claude and Pi and keeps sibling ACP candidates visibly disabled", () => {
    const html = renderRunner({
      provider: "acpx",
      acpxAgent: "claude",
      acpxPermissionMode: "approve-reads",
    });

    expect(html).toContain('<option value="acpx" selected="">ACP agents</option>');
    expect(html).toContain("ACP agent");
    expect(html).toContain('<option value="claude" selected="">Claude</option>');
    expect(html).toContain('<option value="cursor" disabled="">Cursor — qualification pending</option>');
    expect(html).toContain('<option value="copilot" disabled="">GitHub Copilot — qualification pending</option>');
    expect(html).toContain('<option value="pi">Pi</option>');
    expect(html).not.toContain('<option value="pi" disabled="">');
    expect(html).not.toContain("Codex via ACPX");
    expect(html).not.toContain("ACPX Codex");
    expect(html).not.toContain("Pi via ACPX");
    expect(html).toContain("Allow Paperclip reads");
  });

  it.each([undefined, "agent", "plan", "ask"])("displays saved Cursor mode %s", acpxSessionMode => {
    const html = renderRunner({ provider: "acpx", acpxAgent: "cursor", acpxSessionMode });
    const selected = acpxSessionMode ?? "agent";
    expect(html).toContain('aria-label="Cursor mode"');
    expect(html).toContain(`<option value="${selected}" selected="">`);
  });

  it.each([undefined, "off", "low", "high", "max"])("displays saved Pi thinking level %s", piThinkingLevel => {
    const html = renderRunner({ provider: "acpx", acpxAgent: "pi", piThinkingLevel });
    expect(html).toContain('aria-label="Pi thinking level"');
    expect(html).toContain(`<option value="${piThinkingLevel ?? "low"}" selected="">`);
  });
  it("shows unsupported saved Pi level without aliasing it", () => {
    expect(renderRunner({ provider: "acpx", acpxAgent: "pi", piThinkingLevel: "medium" })).toContain("Unsupported saved thinking level");
  });
  it.each(["claude", "copilot", "pi"])("does not expose Cursor mode for %s", acpxAgent => {
    expect(renderRunner({ provider: "acpx", acpxAgent })).not.toContain('aria-label="Cursor mode"');
  });

  it("falls back to the fail-closed Codex permission mode", () => {
    const html = renderRunner({ codexPermissionMode: "unrestricted" });

    expect(html).toContain("Unsupported saved mode — select a qualified mode");
    expect(html).toContain("cannot start or recover a Paperclip Runner run");
    expect(html).toContain("Select Automatic (isolated) to remediate it");
    expect(html).not.toContain("Full auto (never ask)");
  });

  it("shows a bounded idle timeout only for warm sessions", () => {
    const warmHtml = renderRunner({
      lifecycleMode: "warm",
      idleTimeoutMs: 45_000,
    });
    const turnHtml = renderRunner({
      lifecycleMode: "per_turn",
      idleTimeoutMs: 45_000,
    });

    expect(warmHtml).toContain("Warm idle timeout (ms)");
    expect(warmHtml).toContain('value="45000"');
    expect(warmHtml).toContain('max="86400000"');
    expect(turnHtml).not.toContain("Warm idle timeout (ms)");
  });
});
