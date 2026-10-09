import * as React from "react";

import { Button } from "@paperclipai/paperclip-runner/react";
import type { CapabilityScenarioIndexEntry } from "@paperclip-runner-local/capability";

import { DISPOSITION_LABEL, groupLabel, PARITY_LABEL, ROLE_LABEL } from "../labels.js";
import { activeFilterChips, hasActiveFilters, type CapabilityFilters } from "../route.js";
import { DispositionBadge, EmptyState, Mono, ParityStatusBadge } from "./primitives.js";

/**
 * Scenario picker — search, facets, and a single-select listbox over the
 * generated scenario index. The picker consumes the index; it never re-derives
 * group membership or dispositions (UX map §2).
 */

export interface CapabilityFacetValue {
  value: string;
  label: string;
  count: number;
}

export interface CapabilityPickerFacets {
  group: CapabilityFacetValue[];
  disposition: CapabilityFacetValue[];
  role: CapabilityFacetValue[];
  claim: CapabilityFacetValue[];
  parity: CapabilityFacetValue[];
}

export interface ScenarioPickerProps {
  entries: readonly CapabilityScenarioIndexEntry[];
  visible: readonly CapabilityScenarioIndexEntry[];
  facets: CapabilityPickerFacets;
  filters: CapabilityFilters;
  selectedId: string | null;
  parityStatus: (id: string) => "pass" | "fail" | "intentional_gap" | "not_run";
  onFilterChange: (next: Partial<CapabilityFilters>) => void;
  onClearFilters: () => void;
  onSelect: (id: string) => void;
  onCommitSelection: (id: string) => void;
}

const FACET_ORDER: Array<{ key: keyof CapabilityPickerFacets; label: string }> = [
  { key: "group", label: "Group" },
  { key: "disposition", label: "Disposition" },
  { key: "role", label: "Role" },
  { key: "claim", label: "Claim" },
  { key: "parity", label: "Parity status" },
];

export function ScenarioPicker({
  entries,
  visible,
  facets,
  filters,
  selectedId,
  parityStatus,
  onFilterChange,
  onClearFilters,
  onSelect,
  onCommitSelection,
}: ScenarioPickerProps) {
  const searchId = React.useId();
  const listRef = React.useRef<HTMLDivElement>(null);
  const typeahead = React.useRef("");
  const typeaheadTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const chips = activeFilterChips(filters);
  const grouped = groupEntries(visible);

  React.useEffect(
    () => () => {
      if (typeaheadTimer.current !== null) clearTimeout(typeaheadTimer.current);
    },
    [],
  );

  React.useEffect(() => {
    if (selectedId === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(`case-row-${selectedId}`)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function move(delta: number) {
    if (visible.length === 0) return;
    const current = visible.findIndex((entry) => entry.id === selectedId);
    const next = visible[Math.min(Math.max(current + delta, 0), visible.length - 1)] ?? visible[0];
    if (next !== undefined) onSelect(next.id);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      if (visible[0] !== undefined) onSelect(visible[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = visible[visible.length - 1];
      if (last !== undefined) onSelect(last.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = visible.find((entry) => entry.id === selectedId) ?? visible[0];
      if (selected !== undefined) onCommitSelection(selected.id);
    } else if (isTypeaheadKey(event)) {
      event.preventDefault();
      if (typeaheadTimer.current !== null) clearTimeout(typeaheadTimer.current);
      typeahead.current += event.key.toLowerCase();
      const next = findTypeaheadMatch(visible, selectedId, typeahead.current);
      if (next !== null) onSelect(next.id);
      typeaheadTimer.current = setTimeout(() => {
        typeahead.current = "";
        typeaheadTimer.current = null;
      }, 700);
    }
  }

  return (
    <nav
      className="pcr7-rail"
      aria-label="Scenario picker"
      data-testid="scenario-picker"
      tabIndex={-1}
    >
      <div className="pcr7-rail-head">
        <h2 className="pcr7-rail-title">Scenarios</h2>
        <p className="pcr7-muted" data-testid="scenario-count">
          {visible.length} of {entries.length} scenarios
        </p>
      </div>

      <div className="pcr7-field">
        <label htmlFor={searchId}>Search case ID or title</label>
        <input
          id={searchId}
          type="search"
          className="pcr7-input"
          data-testid="scenario-search"
          value={filters.query}
          placeholder="hb-scoped-wake"
          onChange={(event) => onFilterChange({ query: event.target.value })}
        />
      </div>

      {chips.length === 0 ? null : (
        <div className="pcr7-chip-row" data-testid="active-filters">
          {chips.map((chip) => (
            <button
              key={`${chip.key}:${chip.value}`}
              type="button"
              className="pcr7-chip"
              data-testid={`active-filter-${chip.key}`}
              onClick={() =>
                onFilterChange(chip.key === "query" ? { query: "" } : ({ [chip.key]: null } as Partial<CapabilityFilters>))
              }
            >
              {chip.label}: <Mono>{chip.value}</Mono> <span aria-hidden="true">×</span>
              <span className="pcr7-visually-hidden"> remove filter</span>
            </button>
          ))}
        </div>
      )}
      {hasActiveFilters(filters) ? (
        <Button type="button" variant="ghost" data-testid="clear-filters" onClick={onClearFilters}>
          Clear filters
        </Button>
      ) : null}

      {FACET_ORDER.map(({ key, label }) => (
        <details key={key} className="pcr7-facet" data-testid={`facet-${key}`} open={key === "group"}>
          <summary className="pcr7-facet-summary">{label}</summary>
          <div className="pcr7-facet-values">
            {facets[key].map((facet) => {
              const active = filters[key] === facet.value;
              return (
                <button
                  key={facet.value}
                  type="button"
                  className="pcr7-facet-value"
                  aria-pressed={active}
                  disabled={facet.count === 0 && !active}
                  data-testid={`facet-${key}-${facet.value}`}
                  onClick={() =>
                    onFilterChange({ [key]: active ? null : facet.value } as Partial<CapabilityFilters>)
                  }
                >
                  <span>{facet.label}</span>
                  <span className="pcr7-facet-count">{facet.count}</span>
                </button>
              );
            })}
          </div>
        </details>
      ))}

      {visible.length === 0 ? (
        <EmptyState title="No scenarios match these filters.">
          <Button type="button" onClick={onClearFilters}>
            Clear filters
          </Button>
        </EmptyState>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Scenario cases"
          tabIndex={0}
          className="pcr7-case-list"
          data-testid="case-list"
          aria-activedescendant={selectedId === null ? undefined : `case-row-${selectedId}`}
          onKeyDown={onKeyDown}
        >
          {grouped.map(([group, groupEntriesList]) => (
            <div key={group} className="pcr7-case-group">
              <h3 className="pcr7-case-group-title">
                {groupLabel(group)} <Mono>{group}</Mono>
                <span className="pcr7-facet-count">{groupEntriesList.length}</span>
              </h3>
              {groupEntriesList.map((entry) => (
                <div
                  key={entry.id}
                  id={`case-row-${entry.id}`}
                  role="option"
                  aria-selected={entry.id === selectedId}
                  className="pcr7-case-row"
                  data-testid={`case-row-${entry.id}`}
                  data-selected={entry.id === selectedId}
                  onClick={() => onSelect(entry.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onCommitSelection(entry.id);
                    }
                  }}
                  tabIndex={-1}
                >
                  <Mono>{entry.id}</Mono>
                  <span className="pcr7-case-title" title={entry.title}>
                    {entry.title}
                  </span>
                  <span className="pcr7-case-meta">
                    <DispositionBadge disposition={entry.primaryDisposition} />
                    <ParityStatusBadge
                      status={parityStatus(entry.id)}
                      testId={`case-parity-${entry.id}`}
                    />
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}

function isTypeaheadKey(event: React.KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    event.key.trim().length > 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  );
}

export function findTypeaheadMatch(
  entries: readonly CapabilityScenarioIndexEntry[],
  selectedId: string | null,
  rawQuery: string,
): CapabilityScenarioIndexEntry | null {
  if (entries.length === 0) return null;
  const normalized = rawQuery.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const query = [...normalized].every((character) => character === normalized[0])
    ? normalized[0]!
    : normalized;
  const selectedIndex = entries.findIndex((entry) => entry.id === selectedId);
  for (let offset = 1; offset <= entries.length; offset += 1) {
    const index = (Math.max(selectedIndex, -1) + offset) % entries.length;
    const entry = entries[index]!;
    if (entry.id.toLowerCase().startsWith(query) || entry.title.toLowerCase().startsWith(query)) {
      return entry;
    }
  }
  return null;
}

function groupEntries(
  entries: readonly CapabilityScenarioIndexEntry[],
): Array<[string, CapabilityScenarioIndexEntry[]]> {
  const byGroup = new Map<string, CapabilityScenarioIndexEntry[]>();
  for (const entry of entries) {
    const bucket = byGroup.get(entry.group) ?? [];
    bucket.push(entry);
    byGroup.set(entry.group, bucket);
  }
  return [...byGroup.entries()].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Facet counts are computed against the results of every *other* facet, so a
 * selected value still shows how many scenarios it would return and unselected
 * values show what selecting them would do (recognition over recall).
 */
export function buildFacets(
  entries: readonly CapabilityScenarioIndexEntry[],
  countFor: (key: keyof CapabilityPickerFacets, value: string) => number,
): CapabilityPickerFacets {
  const uniq = (values: string[]): string[] => [...new Set(values)].sort();
  return {
    group: uniq(entries.map((entry) => entry.group)).map((group) => ({
      value: group,
      label: `${groupLabel(group)} (${group})`,
      count: countFor("group", group),
    })),
    disposition: (
      ["control_plane_owned", "always_agent_tool", "optional_agent_tool"] as const
    ).map((disposition) => ({
      value: disposition,
      label: DISPOSITION_LABEL[disposition],
      count: countFor("disposition", disposition),
    })),
    role: uniq(entries.map((entry) => entry.actorRole)).map((role) => ({
      value: role,
      label: ROLE_LABEL[role] ?? role,
      count: countFor("role", role),
    })),
    claim: uniq(entries.flatMap((entry) => entry.requiredGrants)).map((claim) => ({
      value: claim,
      label: claim,
      count: countFor("claim", claim),
    })),
    parity: (["pass", "fail", "intentional_gap", "not_run"] as const).map((status) => ({
      value: status,
      label: PARITY_LABEL[status],
      count: countFor("parity", status),
    })),
  };
}
