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
  it("exposes all qualified provider choices", () => {
    const html = renderRunner({ provider: "codex" });

    expect(html).toContain('<option value="codex" selected="">Codex</option>');
    expect(html).toContain("OpenCode 1.18.17");
    expect(html).toContain("ACPX");
    expect(html).toContain("Full auto (never ask)");
    expect(html).toContain("Ask when requested");
    expect(html).toContain("Ask for untrusted operations");
    expect(html).toContain("Claude Managed");
    expect(html).toContain("AWS AgentCore");
    expect(html).not.toContain("Bypass sandbox");
  });

  it("renders OpenCode's bounded permission modes", () => {
    const html = renderRunner({
      provider: "opencode",
      opencodePermissionMode: "allow",
    });

    expect(html).toContain('<option value="opencode" selected="">OpenCode 1.18.17</option>');
    expect(html).toContain('<option value="allow" selected="">Full auto (allow)</option>');
    expect(html).toContain("Ask for permission");
    expect(html).toContain("Deny operations");
    expect(html).not.toContain("Ask for untrusted operations");
  });

  it("renders only the qualified ACPX Claude and Codex profiles", () => {
    const html = renderRunner({
      provider: "acpx",
      acpxAgent: "claude",
      acpxPermissionMode: "approve-reads",
    });

    expect(html).toContain('<option value="acpx" selected="">ACPX</option>');
    expect(html).toContain('<option value="claude" selected="">Claude via ACPX</option>');
    expect(html).toContain("Codex via ACPX");
    expect(html).not.toContain("Pi via ACPX");
    expect(html).toContain('<option value="approve-reads" selected="">Ask for mutations</option>');
  });

  it("falls back to the fail-closed Codex permission mode", () => {
    const html = renderRunner({ codexPermissionMode: "unrestricted" });

    expect(html).toContain('<option value="untrusted" selected="">Ask for untrusted operations</option>');
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
