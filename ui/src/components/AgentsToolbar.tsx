import { t, useTranslation } from "@/i18n";
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
  useTranslation();
  return <div data-canonical-toolbar="agents" role="toolbar" aria-label={t("oct26Toolbar.agentsControls")} className="flex flex-wrap items-center gap-3">
    <div className="design-toolbar-controls flex w-full flex-wrap items-center gap-4">
      <ToolbarSearch query={query} onQueryChange={onQueryChange} label={t("oct26Toolbar.searchAgents")} placeholder={t("oct26Toolbar.searchAgentsPlaceholder")} />
      {!hideViewToggle && <div className="design-view-toggle" role="group" aria-label={t("oct26Toolbar.agentView")}>
          <Button type="button" size="icon-sm" variant={view === "list" ? "secondary" : "ghost"} className="design-toolbar-icon" onClick={() => onViewChange("list")} title={t("oct26Toolbar.listView")} aria-label={t("oct26Toolbar.listView")} aria-pressed={view === "list"}><List aria-hidden /></Button>
          <Button type="button" size="icon-sm" variant={view === "org" ? "secondary" : "ghost"} className="design-toolbar-icon" onClick={() => onViewChange("org")} title={t("oct26Toolbar.orgView")} aria-label={t("oct26Toolbar.orgView")} aria-pressed={view === "org"}><Network aria-hidden /></Button>
      </div>}
      <div className="design-toolbar-actions">
        <Button size="sm" variant="outline" data-toolbar-primary onClick={onNewAgent}><Plus aria-hidden />{t("oct26Toolbar.newAgent")}</Button>
      </div>
    </div>
  </div>;
}
