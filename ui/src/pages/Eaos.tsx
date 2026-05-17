/**
 * LET-326: Enterprise Agent OS (EAOS) command center — read-only Sandbox &
 * runtime dashboard. Phase 4A slice. This page composes the safety-posture
 * banner, the runtime & sandboxes module, and the read-only artifact /
 * evidence browser.
 *
 * Hard constraints (also enforced by the modules below):
 *   - No live sandbox start/stop, no real egress, no runtime control
 *     mutation, no MCP execution, no spend.
 *   - Risky controls are simply not rendered. Where the future Command
 *     Center would expose a button, this slice shows the labels only.
 *   - Missing fields render as Unknown; backend failures render as Partial
 *     / red alert and never as green.
 */

import { useEffect, useState } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { SafetyPostureBanner } from "./eaos/SafetyPostureBanner";
import { RuntimeSandboxesModule } from "./eaos/RuntimeSandboxesModule";
import { ArtifactEvidenceBrowser } from "./eaos/ArtifactEvidenceBrowser";

export function Eaos() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [partial, setPartial] = useState<boolean>(false);

  useEffect(() => {
    const companyCrumb = selectedCompany ? [{ label: selectedCompany.name, href: "/dashboard" }] : [];
    setBreadcrumbs([...companyCrumb, { label: "EAOS Sandbox & runtime" }]);
  }, [selectedCompany, setBreadcrumbs]);

  return (
    <main
      className="mx-auto max-w-7xl space-y-6 p-4 lg:p-6"
      aria-labelledby="eaos-heading"
    >
      <header className="space-y-3">
        <h1 id="eaos-heading" className="text-2xl font-semibold tracking-tight">
          EAOS — Sandbox &amp; runtime dashboard{" "}
          <span className="text-base font-normal text-muted-foreground">(preview / stub)</span>
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Read-only Enterprise Agent OS command center. Backed by the LET-314 / LET-323 preview-only
          sandbox APIs plus existing live-runs, workspaces, and approvals reads. The sandbox /
          runtime stack itself is still a stub: no real container isolation, no real egress
          enforcement, and no runtime service mutation has shipped yet — see ADR LET-328 for the
          buy-vs-build decision driving this surface.
        </p>
      </header>

      <SafetyPostureBanner generatedAt={generatedAt} partial={partial} />

      {selectedCompanyId ? (
        <>
          <RuntimeSandboxesModule
            companyId={selectedCompanyId}
            onGeneratedAt={(ts, isPartial) => {
              setGeneratedAt(ts);
              setPartial(isPartial);
            }}
          />
          <ArtifactEvidenceBrowser companyId={selectedCompanyId} />
        </>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          Select a company to view its EAOS sandbox &amp; runtime state.
        </div>
      )}
    </main>
  );
}
