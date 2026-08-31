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

describe("Paperclip Runner permission configuration", () => {
  it.each([
    ["codex", ["Full auto (never ask)", "Ask when requested", "Ask for untrusted operations"]],
    ["opencode", ["Full auto (allow)", "Ask for permission", "Deny operations"]],
    ["acpx", ["Full auto (approve all)", "Ask for mutations", "Deny all"]],
  ] as const)("shows only the %s permission catalog", (provider, labels) => {
    const html = renderRunner({ provider });
    for (const label of labels) expect(html).toContain(label);
    expect(html).not.toContain("Bypass sandbox");
  });

  it.each(["claude_managed", "aws_agentcore"] as const)(
    "keeps a saved deferred %s provider readable without exposing its configuration",
    (provider) => {
      const html = renderRunner({ provider });
      expect(html).toContain("Saved provider unavailable in this release");
      expect(html).not.toContain('value="claude_managed"');
      expect(html).not.toContain('value="aws_agentcore"');
      expect(html).not.toContain("Ask for mutations");
      expect(html).not.toContain("Bypass sandbox");
      expect(html).not.toContain("Managed Agent profile");
      expect(html).not.toContain("AgentCore profile");
    },
  );

  it("offers only qualified Pi and Claude ACPX agents", () => {
    const html = renderRunner({ provider: "acpx", acpxAgent: "codex" });
    expect(html).toContain("Saved ACP agent unavailable in this release");
    expect(html).toContain("Pi via ACPX");
    expect(html).toContain("Claude via ACPX");
    expect(html).not.toContain("Codex via ACPX");
  });

  it("renders a previously stored lower mode after switching back to a provider", () => {
    const html = renderRunner({
      provider: "acpx",
      codexPermissionMode: "untrusted",
      opencodePermissionMode: "deny",
      acpxPermissionMode: "approve-reads",
    });
    expect(html).toContain('<option value="approve-reads" selected="">Ask for mutations</option>');
    expect(html).not.toContain("Ask when requested");
  });
});
