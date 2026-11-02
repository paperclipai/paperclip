import { t, useTranslation } from "@/i18n";
import { useId, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { Bot, Search, User } from "lucide-react";
import type { IssueFiltersPopover } from "./IssueFiltersPopover";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { FlyoutHeader } from "./ui/flyout";
import { StatusIcon } from "./StatusIcon";
import { TruncatedText } from "./TruncatedText";
import { issueFilterLabel, issueStatusOrder, searchIssueFilterOptions, toggleIssueFilterValue } from "@/lib/issue-filters";

type PanelProps = Pick<ComponentProps<typeof IssueFiltersPopover>, "state" | "onChange" | "activeFilterCount" | "agents" | "projects" | "labels" | "creators" | "currentUserId"> & { onClear: () => void };

function FilterGroup({ title, searchLabel, query, onQueryChange, children, optionsKey }: { title: string; searchLabel?: "projects" | "creators" | "assignees" | "labels"; query?: string; onQueryChange?: (value: string) => void; children: ReactNode; optionsKey: string }) {
  useTranslation();
  const headingId = useId();
  return (
    <section className="task-filter-group" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <div className="task-filter-group-body">
        {searchLabel ? <div className="task-filter-search"><Search aria-hidden /><Input aria-label={t(`oct26Ui.filters.search${searchLabel[0].toUpperCase()}${searchLabel.slice(1)}`)} placeholder={t(`oct26Ui.filters.search${searchLabel[0].toUpperCase()}${searchLabel.slice(1)}Placeholder`)} value={query} onChange={event => onQueryChange?.(event.target.value)} /></div> : null}
        <div className="task-filter-options" data-filter-options={optionsKey}>{children}</div>
      </div>
    </section>
  );
}

function FilterRow({ label, checked, onToggle, icon }: { label: string; checked: boolean; onToggle: () => void; icon?: ReactNode }) {
  return <label className="task-filter-option" data-marquee-surface><Checkbox aria-label={label} checked={checked} onCheckedChange={onToggle} />{icon ? <span className="task-filter-icon" aria-hidden>{icon}</span> : null}<TruncatedText className="task-filter-option-label">{label}</TruncatedText></label>;
}

/** Proposed five-group IA; the collection retains ownership of filter state. */
export function IssueFilterPanel({ state, onChange, activeFilterCount, agents = [], projects = [], labels = [], creators = [], currentUserId, onClear }: PanelProps) {
  useTranslation();
  const [queries, setQueries] = useState({ projects: "", creators: "", assignees: "", labels: "" });
  const search = (key: keyof typeof queries) => (value: string) => setQueries(current => ({ ...current, [key]: value }));
  const visibleProjects = searchIssueFilterOptions(projects, queries.projects, option => option.name);
  const visibleCreators = searchIssueFilterOptions(creators, queries.creators, option => `${option.label} ${option.searchText ?? ""}`);
  const assignees = [{ id: "__unassigned", name: t("oct26Ui.filters.noAssignee"), icon: null }, ...(currentUserId ? [{ id: "__me", name: t("oct26Ui.filters.me"), icon: <User /> }] : []), ...agents.map(agent => ({ ...agent, icon: null }))];
  const visibleAssignees = searchIssueFilterOptions(assignees, queries.assignees, option => option.name);
  const visibleLabels = searchIssueFilterOptions(labels, queries.labels, option => option.name);
  return <>
    <FlyoutHeader className="task-filters-header"><span>{t("oct26Ui.filters.heading")}</span>{activeFilterCount ? <Button variant="ghost" onClick={() => { onClear(); setQueries({ projects: "", creators: "", assignees: "", labels: "" }); }}>{t("oct26Ui.filters.clear")}</Button> : null}</FlyoutHeader>
    <div className="task-filters-grid">
      <FilterGroup title={t("oct26Ui.filters.status")} optionsKey="statuses">
        {issueStatusOrder.map(status => <FilterRow key={status} label={issueFilterLabel(status)} checked={state.statuses.includes(status)} onToggle={() => onChange({ statuses: toggleIssueFilterValue(state.statuses, status) })} icon={<StatusIcon status={status} />} />)}
      </FilterGroup>
      <FilterGroup title={t("oct26Ui.filters.project")} optionsKey="projects" searchLabel="projects" query={queries.projects} onQueryChange={search("projects")}>
        {visibleProjects.map(project => <FilterRow key={project.id} label={project.name} checked={state.projects.includes(project.id)} onToggle={() => onChange({ projects: toggleIssueFilterValue(state.projects, project.id) })} />)}
        {!visibleProjects.length ? <p className="task-filter-empty">{queries.projects ? t("oct26Ui.filters.noProjectsMatch") : t("oct26Ui.filters.noProjects")}</p> : null}
      </FilterGroup>
      <FilterGroup title={t("oct26Ui.filters.creator")} optionsKey="creators" searchLabel="creators" query={queries.creators} onQueryChange={search("creators")}>
        {visibleCreators.map(creator => <FilterRow key={creator.id} label={creator.label} checked={state.creators.includes(creator.id)} onToggle={() => onChange({ creators: toggleIssueFilterValue(state.creators, creator.id) })} icon={creator.kind === "agent" ? <Bot /> : <User />} />)}
        {!visibleCreators.length ? <p className="task-filter-empty">{queries.creators ? t("oct26Ui.filters.noCreatorsMatch") : t("oct26Ui.filters.noCreators")}</p> : null}
      </FilterGroup>
      <FilterGroup title={t("oct26Ui.filters.assignee")} optionsKey="responsible" searchLabel="assignees" query={queries.assignees} onQueryChange={search("assignees")}>
        {visibleAssignees.map(assignee => <FilterRow key={assignee.id} label={assignee.name} checked={state.assignees.includes(assignee.id)} onToggle={() => onChange({ assignees: toggleIssueFilterValue(state.assignees, assignee.id) })} icon={assignee.icon} />)}
        {!visibleAssignees.length ? <p className="task-filter-empty">{t("oct26Ui.filters.noAssigneesMatch")}</p> : null}
      </FilterGroup>
      <FilterGroup title={t("oct26Ui.filters.label")} optionsKey="labels" searchLabel="labels" query={queries.labels} onQueryChange={search("labels")}>
        {visibleLabels.map(label => <FilterRow key={label.id} label={label.name} checked={state.labels.includes(label.id)} onToggle={() => onChange({ labels: toggleIssueFilterValue(state.labels, label.id) })} icon={<span className="task-filter-label-dot" style={{ "--task-filter-label-color": label.color } as CSSProperties} />} />)}
        {!visibleLabels.length ? <p className="task-filter-empty">{queries.labels ? t("oct26Ui.filters.noLabelsMatch") : t("oct26Ui.filters.noLabels")}</p> : null}
      </FilterGroup>
    </div>
  </>;
}
