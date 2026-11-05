import { useTranslation } from "@/i18n";
import { List, Network, Plus } from "lucide-react";
import { ToolbarSearch } from "./ToolbarSearch";
import { Button } from "./ui/button";

export interface AgentsToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  view: "list" | "org";
  onViewChange: (value: "list" | "org") => void;
  hideViewToggle?: boolean;
  onNewAgent: () => void;
}

/** Shared roster search, view controls and actions for the page and stories. */
export function AgentsToolbar({ query, onQueryChange, view, onViewChange, hideViewToggle, onNewAgent }: AgentsToolbarProps) {
  const { t } = useTranslation("agent-config");
  return <div data-canonical-toolbar="agents" role="toolbar" aria-label={t("agent-config:agentsControls_bd794ec")} className="flex flex-wrap items-center gap-3">
    <div className="design-toolbar-controls flex w-full flex-wrap items-center gap-4">
      <ToolbarSearch query={query} onQueryChange={onQueryChange} label={t("agent-config:searchAgents_f1ff540")} placeholder={t("agent-config:searchAgents_97ce8aa")} />
      {!hideViewToggle && <div className="design-view-toggle" role="group" aria-label={t("agent-config:agentView_16b2f47")}>
          <Button type="button" size="icon-sm" variant={view === "list" ? "secondary" : "ghost"} className="design-toolbar-icon" onClick={() => onViewChange("list")} title={t("agent-config:listView_694bbd7")} aria-label={t("agent-config:listView_694bbd7")} aria-pressed={view === "list"}><List aria-hidden /></Button>
          <Button type="button" size="icon-sm" variant={view === "org" ? "secondary" : "ghost"} className="design-toolbar-icon" onClick={() => onViewChange("org")} title={t("agent-config:orgChartView_dfd2b1a")} aria-label={t("agent-config:orgChartView_dfd2b1a")} aria-pressed={view === "org"}><Network aria-hidden /></Button>
      </div>}
      <div className="design-toolbar-actions">
        <Button size="sm" variant="outline" data-toolbar-primary onClick={onNewAgent}><Plus aria-hidden />{t("agent-config:newAgent_94c537d")}</Button>
      </div>
    </div>
  </div>;
}
