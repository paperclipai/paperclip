import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { Shield, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { nav } from "../lib/i18n";
import {
  orchestrationGatesPage,
  orchestrationGatesRows,
  type OrchestrationGatesTableRow,
} from "../lib/orchestration-gates-copy";

/** 约两行高度（`text-sm` + `leading-relaxed`），需与折叠态 `max-h-[2.875rem]` 一致 */
const SCHED_RULES_COLLAPSED_MAX_PX = 2.875 * 16;

function SchedulingRulesCell({ text }: { text: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setCanExpand(el.scrollHeight > SCHED_RULES_COLLAPSED_MAX_PX);
  }, [text]);

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <div
          ref={bodyRef}
          className={cn(
            "text-foreground/95 leading-relaxed whitespace-pre-line",
            !expanded && "max-h-[2.875rem] overflow-hidden",
          )}
        >
          {text}
        </div>
        {!expanded && canExpand ? (
          <div
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-5 bg-gradient-to-t from-background to-transparent"
            aria-hidden
          />
        ) : null}
      </div>
      {canExpand ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 px-2 text-xs text-primary hover:text-primary"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          {expanded ? orchestrationGatesPage.collapseSchedulingRules : orchestrationGatesPage.expandSchedulingRules}
        </Button>
      ) : null}
    </div>
  );
}

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
          <Link to="/runs" className="inline-flex items-center gap-1 text-primary hover:underline">
            <Workflow className="h-3.5 w-3.5" />
            {orchestrationGatesPage.relatedInjection}
          </Link>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[64rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs font-medium uppercase tracking-wide text-foreground/90">
              <th className="w-44 px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnComponent}</th>
              <th className="w-40 px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnUi}</th>
              <th className="min-w-[14rem] px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnHardcoded}</th>
              <th className="min-w-[14rem] px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnConfigurable}</th>
              <th className="min-w-[12rem] px-3 py-2.5 text-foreground">{orchestrationGatesPage.columnCodeRef}</th>
            </tr>
          </thead>
          <tbody>
            {orchestrationGatesRows.map((row) => (
              <tr key={row.id} className="border-b border-border/80 last:border-b-0">
                <td className="align-top px-3 py-2.5">
                  <div className="text-sm font-medium text-foreground">{row.component}</div>
                </td>
                <td className="align-top px-3 py-2.5">
                  <GateUiLinks links={row.uiLinks} />
                </td>
                <td className="align-top px-3 py-2.5">
                  <SchedulingRulesCell text={row.hardcoded} />
                </td>
                <td className="align-top px-3 py-2.5 text-foreground/95 leading-relaxed">{row.configurable}</td>
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
