/**
 * LET-326 + LET-372: Sandbox / Runtime zone module mounted inside the
 * canonical `/eaos` command-center shell (LET-181/LET-334 reconciliation).
 *
 * Composition:
 *   - Safety posture banner (LET-326 backend-derived truth labels)
 *   - Provider status panel integration seam (LET-368, PR #52)
 *   - Runtime & sandboxes module (LET-326 read-only lease table)
 *   - Artifact / evidence browser (LET-326 read-only artifacts)
 *
 * Hard constraints (also enforced by the modules below):
 *   - No live sandbox start/stop, no real egress, no runtime control
 *     mutation, no MCP execution, no spend.
 *   - Risky controls are simply not rendered. Where the future Command
 *     Center would expose a button, this slice shows the labels only.
 *   - Missing fields render as Unknown; backend failures render as Partial
 *     / red alert and never as green.
 *
 * Landmarks: this module renders a `<section>` only. The EaosShell already
 * owns the `<header role=banner>` / `<nav role=navigation>` / `<section
 * role=region>` / `<footer role=contentinfo>` landmarks, and the Paperclip
 * Layout owns the page-level `<main>`. Rendering an additional `<main>`
 * here would duplicate the landmark.
 */

import { useCallback, useEffect, useState } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { SafetyPostureBanner } from "./eaos/SafetyPostureBanner";
import { RuntimeSandboxesModule } from "./eaos/RuntimeSandboxesModule";
import { ArtifactEvidenceBrowser } from "./eaos/ArtifactEvidenceBrowser";
import { ProviderStatusPanel } from "./eaos/ProviderStatusPanel";

export function Eaos() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [partial, setPartial] = useState<boolean>(false);

  useEffect(() => {
    const companyCrumb = selectedCompany ? [{ label: selectedCompany.name, href: "/dashboard" }] : [];
    setBreadcrumbs([
      ...companyCrumb,
      { label: "EAOS", href: "/eaos" },
      { label: "Sandbox / Runtime" },
    ]);
  }, [selectedCompany, setBreadcrumbs]);

  // Stable identity so RuntimeSandboxesModule's useEffect deps (generatedAt,
  // partial, onGeneratedAt) only re-fire on real value changes, not on every
  // parent render.
  const handleGeneratedAt = useCallback((ts: string | null, isPartial: boolean) => {
    setGeneratedAt(ts);
    setPartial(isPartial);
  }, []);

  return (
    <section
      aria-labelledby="eaos-sandbox-zone-heading"
      className="space-y-6"
      data-testid="eaos-sandbox-runtime-zone"
    >
      <header className="space-y-3">
        <h1 id="eaos-sandbox-zone-heading" className="text-2xl font-semibold tracking-tight">
          Sandbox &amp; runtime{" "}
          <span className="text-base font-normal text-muted-foreground">(preview / stub)</span>
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Read-only Enterprise Agent OS Sandbox / Runtime zone. Backed by the LET-314 / LET-323
          preview-only sandbox APIs plus existing live-runs, workspaces, and approvals reads. The
          sandbox / runtime stack itself is still a stub: no real container isolation, no real
          egress enforcement, and no runtime service mutation has shipped yet — see ADR LET-328 for
          the buy-vs-build decision driving this surface.
        </p>
      </header>

      <SafetyPostureBanner generatedAt={generatedAt} partial={partial} />

      {/*
        LET-368 ProviderStatusPanel integration seam. The provider-status
        panel (PR #52) mounts here once LET-368 lands on master; until then
        this comment marks the integration slot. The panel renders directly
        above RuntimeSandboxesModule so the provider-allow-live posture and
        billing-cap auto-disable state are visible before the lease table.
      */}

      {selectedCompanyId ? (
        <>
          <ProviderStatusPanel companyId={selectedCompanyId} />
          <RuntimeSandboxesModule
            companyId={selectedCompanyId}
            onGeneratedAt={handleGeneratedAt}
          />
          <ArtifactEvidenceBrowser companyId={selectedCompanyId} />
        </>
      ) : (
        <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
          Select a company to view its EAOS sandbox &amp; runtime state.
        </div>
      )}
    </section>
  );
}
