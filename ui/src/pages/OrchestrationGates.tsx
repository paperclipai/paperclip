import { useEffect } from "react";
import { Link } from "@/lib/router";
import { Shield, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import {
  nav,
  orchestrationGatesPage,
  orchestrationGatesRows,
  type OrchestrationGatesTableRow,
} from "../lib/i18n";

function GateUiLinks({ links }: { links: OrchestrationGatesTableRow["uiLinks"] }) {
  if (links.length === 0) {
    return <span className="text-foreground/70">{orchestrationGatesPage.uiNone}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((l) => (
        <Button key={`${l.to}-${l.labelKey}`} variant="outline" size="sm" className="h-7 px-2 text-xs" asChild>
          <Link to={l.to}>{orchestrationGatesPage[l.labelKey]}</Link>
        </Button>
      ))}
    </div>
  );
}

export function OrchestrationGates() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: nav.work }, { label: nav.orchestrationGates }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Shield} message={orchestrationGatesPage.selectCompany} />;
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-foreground/70" />
          <h1 className="text-lg font-semibold text-foreground">{orchestrationGatesPage.title}</h1>
        </div>
        <p className="text-sm text-foreground/90">{orchestrationGatesPage.subtitle}</p>
        <p className="max-w-[52rem] text-xs text-foreground/85 leading-relaxed">{orchestrationGatesPage.notInScope}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
          <Link to="/heartbeat-tasks" className="text-primary hover:underline">
            {orchestrationGatesPage.relatedHeartbeatTasks}
          </Link>
          <Link to="/orchestration-injection" className="inline-flex items-center gap-1 text-primary hover:underline">
            <Workflow className="h-3.5 w-3.5" />
            {orchestrationGatesPage.relatedInjection}
          </Link>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[80rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium uppercase tracking-wide text-foreground/90">
              <th className="w-44 px-3 py-2.5 normal-case">
                <div className="text-xs font-medium tracking-wide text-foreground">{orchestrationGatesPage.columnComponent}</div>
                <div className="mt-0.5 text-[11px] font-normal normal-case tracking-normal text-foreground/80">
                  {orchestrationGatesPage.columnGateScope}
                </div>
              </th>
              <th className="w-40 px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnUi}</th>
              <th className="min-w-[14rem] px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnConfigurable}</th>
              <th className="min-w-[14rem] px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnHardcoded}</th>
              <th className="min-w-[11rem] px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnTrigger}</th>
              <th className="min-w-[11rem] px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnOutcome}</th>
              <th className="min-w-[12rem] px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnCodeRef}</th>
            </tr>
          </thead>
          <tbody>
            {orchestrationGatesRows.map((row) => (
              <tr key={row.id} className="border-b border-border/80 last:border-b-0">
                <td className="align-top px-3 py-2.5">
                  <div className="text-sm font-medium text-foreground">{row.component}</div>
                  <div className="mt-1 text-xs font-normal text-foreground/85 leading-relaxed">{row.gate}</div>
                </td>
                <td className="align-top px-3 py-2.5">
                  <GateUiLinks links={row.uiLinks} />
                </td>
                <td className="align-top px-3 py-2.5 text-foreground/95 leading-relaxed">{row.configurable}</td>
                <td className="align-top px-3 py-2.5 text-foreground/95 leading-relaxed">{row.hardcoded}</td>
                <td className="align-top px-3 py-2.5 text-foreground/95 leading-relaxed">{row.trigger}</td>
                <td className="align-top px-3 py-2.5 text-foreground/95 leading-relaxed">{row.outcome}</td>
                <td className="align-top px-3 py-2.5 font-mono text-[11px] text-foreground/80 leading-snug">{row.codeRef}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="max-w-[52rem] text-xs text-foreground/85 leading-relaxed">{orchestrationGatesPage.footnote}</p>
    </div>
  );
}
