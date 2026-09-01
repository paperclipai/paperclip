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
  it("exposes only the qualified Codex provider and permission modes", () => {
    const html = renderRunner({ provider: "opencode" });

    expect(html).toContain('disabled=""><option value="codex" selected="">Codex</option>');
    expect(html).toContain("Full auto (never ask)");
    expect(html).toContain("Ask when requested");
    expect(html).toContain("Ask for untrusted operations");
    expect(html).not.toContain("OpenCode");
    expect(html).not.toContain("ACPX");
    expect(html).not.toContain("Claude Agent");
    expect(html).not.toContain("AWS AgentCore");
    expect(html).not.toContain("Bypass sandbox");
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
