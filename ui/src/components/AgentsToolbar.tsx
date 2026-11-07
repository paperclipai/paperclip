import { List, Network, Plus } from "lucide-react";
import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation();
  return <div data-canonical-toolbar="agents" role="toolbar" aria-label={t("agents.toolbar.controlsAriaLabel")} className="flex flex-wrap items-center gap-3">
    <div className="design-toolbar-controls flex w-full flex-wrap items-center gap-4">
      <ToolbarSearch query={query} onQueryChange={onQueryChange} label={t("agents.toolbar.searchLabel")} placeholder={t("agents.toolbar.searchPlaceholder")} />
      {!hideViewToggle && <div className="design-view-toggle" role="group" aria-label={t("agents.toolbar.viewAriaLabel")}>
          <Button type="button" size="icon-sm" variant={view === "list" ? "secondary" : "ghost"} className="design-toolbar-icon" onClick={() => onViewChange("list")} title={t("agents.list.listView")} aria-label={t("agents.list.listView")} aria-pressed={view === "list"}><List aria-hidden /></Button>
          <Button type="button" size="icon-sm" variant={view === "org" ? "secondary" : "ghost"} className="design-toolbar-icon" onClick={() => onViewChange("org")} title={t("agents.list.orgChartView")} aria-label={t("agents.list.orgChartView")} aria-pressed={view === "org"}><Network aria-hidden /></Button>
      </div>}
      <div className="design-toolbar-actions">
        <Button size="sm" variant="outline" data-toolbar-primary onClick={onNewAgent}><Plus aria-hidden />{t("agents.list.newAgent")}</Button>
      </div>
    </div>
  </div>;
}
