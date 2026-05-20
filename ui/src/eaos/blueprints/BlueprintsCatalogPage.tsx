// LET-501 follow-on C — operator-facing Blueprint catalog.
//
// Backend contract: GET /api/companies/:companyId/blueprints from
// LET-498 / PR #92. Response shape `{ enabled, versions[] }`. When
// `enabled === false` we render a truthful "feature disabled" callout —
// not an empty state — because empty would imply the operator simply has
// no blueprints, which is a different thing.
//
// Operator/admin split (LET-497 §10):
//   * No authoring / edit / publish / deprecate / restart / deploy /
//     spend / live-MCP / raw-secret controls on this page.
//   * No fake popularity / activity / success metrics. Counts only show
//     "N loaded" truth labels — same vocabulary as the other LET-484
//     working-product slices.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { blueprintsApi, type BlueprintCatalogEntry } from "@/api/blueprints";
import { EaosPageHeader } from "../EaosPageHeader";
import { EaosStateChip } from "../EaosStateChip";
import { redactSecretLikeText } from "../secret-redact";
import {
  BLUEPRINT_CATEGORY_LABEL,
  BLUEPRINT_FILTER_CATEGORIES,
  DEFAULT_FILTERS,
  filterCatalogEntries,
  isCatalogEnabled,
  summarizeCatalog,
  summarizePermissionPosture,
  type BlueprintCatalogFilters,
  type BlueprintFilterCategory,
} from "./blueprint-helpers";

export function BlueprintsCatalogPage() {
  const { selectedCompanyId } = useCompany();
  const [filters, setFilters] = useState<BlueprintCatalogFilters>(DEFAULT_FILTERS);

  const catalogQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.blueprints.list(selectedCompanyId)
      : (["blueprints", "__no-company__"] as const),
    queryFn: () => blueprintsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const data = catalogQuery.data;
  const enabled = isCatalogEnabled(data);
  const loaded = useMemo<BlueprintCatalogEntry[]>(
    () => (enabled ? (data?.versions ?? []) : []),
    [enabled, data?.versions],
  );
  const visible = useMemo(() => filterCatalogEntries(loaded, filters), [loaded, filters]);
  const summary = useMemo(() => summarizeCatalog(loaded, visible), [loaded, visible]);

  const isLoading = Boolean(selectedCompanyId) && catalogQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && catalogQuery.isError;
  const hasData = !isLoading && !isError && catalogQuery.isSuccess;
  const dataConnected = hasData;

  return (
    <section
      aria-labelledby="eaos-blueprints-title"
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-blueprints-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
      data-eaos-catalog-enabled={hasData ? (enabled ? "true" : "false") : "unknown"}
    >
      <EaosPageHeader title="Agent Builder" testId="eaos-blueprints-page-header" />
      <h1 id="eaos-blueprints-title" className="sr-only" data-testid="eaos-blueprints-title">
        Blueprints
      </h1>

      <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
        {!selectedCompanyId ? (
          <NoCompanyState />
        ) : isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={readErrorMessage(catalogQuery.error)} />
        ) : !enabled ? (
          <DisabledState />
        ) : loaded.length === 0 ? (
          <EmptyState />
        ) : (
          <CatalogBody
            filters={filters}
            onFiltersChange={setFilters}
            loaded={loaded}
            visible={visible}
            summary={summary}
          />
        )}
      </div>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load blueprint catalog.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprints-no-company"
    >
      Select a company scope from the top bar to load the blueprint catalog. This surface only
      reads the catalog scoped to the currently selected company.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprints-loading"
    >
      Loading blueprint catalog…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-blueprints-error"
    >
      <p className="font-medium">Could not load blueprints.</p>
      <p className="mt-1 text-xs">{redactSecretLikeText(message)}</p>
      <p className="mt-1 text-xs">Refresh to try again.</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprints-empty"
    >
      No blueprints yet. Published blueprints show up here.
    </div>
  );
}

function DisabledState() {
  return (
    <div
      role="status"
      className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      data-testid="eaos-blueprints-disabled"
    >
      <p className="font-medium">Blueprint catalog is currently disabled.</p>
      <p className="mt-1 text-xs">
        The catalog feature flag is off for this instance, so no blueprint versions are exposed
        through the API. An admin must enable it before instantiation flows are available.
      </p>
    </div>
  );
}

function CatalogBody({
  filters,
  onFiltersChange,
  loaded,
  visible,
  summary,
}: {
  filters: BlueprintCatalogFilters;
  onFiltersChange: (next: BlueprintCatalogFilters) => void;
  loaded: readonly BlueprintCatalogEntry[];
  visible: readonly BlueprintCatalogEntry[];
  summary: ReturnType<typeof summarizeCatalog>;
}) {
  return (
    <>
      <Filters filters={filters} onChange={onFiltersChange} summary={summary} />
      <p
        className="text-xs text-muted-foreground"
        data-testid="eaos-blueprints-count-truth"
      >
        Showing <strong className="font-semibold text-foreground">{summary.visibleCount}</strong>{" "}
        of <strong className="font-semibold text-foreground">{summary.loadedCount}</strong>{" "}
        loaded blueprint versions. Counts reflect the current backend read only — no popularity,
        activity, or success metrics are inferred.
      </p>
      {visible.length === 0 ? (
        <FilteredEmpty />
      ) : (
        <ul
          className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
          data-testid="eaos-blueprints-cards"
        >
          {visible.map((entry) => (
            <BlueprintCard key={entry.ref} entry={entry} />
          ))}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground" data-testid="eaos-blueprints-deferred-note">
        Instantiate, author, and publish controls are coming soon.
      </p>
    </>
  );
}

function Filters({
  filters,
  onChange,
  summary,
}: {
  filters: BlueprintCatalogFilters;
  onChange: (next: BlueprintCatalogFilters) => void;
  summary: ReturnType<typeof summarizeCatalog>;
}) {
  const perCategory = useMemo(() => {
    const map = new Map(summary.perCategory.map((entry) => [entry.category, entry.count]));
    return map;
  }, [summary.perCategory]);

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3 md:flex-row md:items-end md:gap-4"
      data-testid="eaos-blueprints-filters"
    >
      <label className="flex flex-1 flex-col gap-1 text-xs">
        <span className="uppercase tracking-wide text-muted-foreground">Search</span>
        <input
          type="search"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          value={filters.search}
          onChange={(event) => onChange({ ...filters, search: event.target.value })}
          placeholder="Filter by title, ref, or description"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-blueprints-search"
        />
      </label>
      <fieldset
        className="flex flex-1 flex-col gap-1 text-xs"
        data-testid="eaos-blueprints-category-filter"
      >
        <span className="uppercase tracking-wide text-muted-foreground">Category</span>
        <div className="flex flex-wrap gap-1.5">
          {BLUEPRINT_FILTER_CATEGORIES.map((category) => {
            const active = filters.category === category;
            const countLabel = describeFilterCount(category, perCategory, summary.loadedCount);
            return (
              <button
                key={category}
                type="button"
                onClick={() => onChange({ ...filters, category })}
                aria-pressed={active}
                data-testid={`eaos-blueprints-category-${category}`}
                className={
                  "rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide " +
                  (active
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-foreground hover:bg-muted")
                }
              >
                {category === "all" ? "All" : BLUEPRINT_CATEGORY_LABEL[category]}{" "}
                <span className="font-normal tabular-nums">{countLabel}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

function describeFilterCount(
  category: BlueprintFilterCategory,
  perCategory: Map<BlueprintCatalogEntry["category"], number>,
  loadedTotal: number,
): string {
  if (category === "all") return `(${loadedTotal})`;
  return `(${perCategory.get(category) ?? 0})`;
}

function FilteredEmpty() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-blueprints-filtered-empty"
    >
      No blueprints match the current filters. Clear the search or pick a different category.
    </div>
  );
}

function BlueprintCard({ entry }: { entry: BlueprintCatalogEntry }) {
  const posture = summarizePermissionPosture(entry);
  const description = redactSecretLikeText(entry.description);
  // The catalog backend declares ref/key as schema-constrained identifiers
  // (slug + "@" + semver), so redactSecretLikeText is a no-op on legitimate
  // values. We still pipe them through it for the visible card text and any
  // DOM data attributes so a credential-shaped backend value can never escape
  // through innerHTML — covered by the static and runtime sentinel tests.
  const safeRef = redactSecretLikeText(entry.ref);
  const safeKey = redactSecretLikeText(entry.key);
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-blueprints-card"
      data-blueprint-ref={safeRef}
      data-blueprint-key={safeKey}
      data-blueprint-category={entry.category}
    >
      <div className="flex flex-wrap items-center gap-2">
        <EaosStateChip
          label={entry.status === "published" ? "PUBLISHED" : entry.status.toUpperCase()}
          prefix="Status"
          title={`Blueprint status: ${entry.status}`}
        />
        <span
          className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          data-testid="eaos-blueprints-card-category"
        >
          {BLUEPRINT_CATEGORY_LABEL[entry.category]}
        </span>
        {posture.hasLiveExternalActionRisk ? (
          <EaosStateChip
            label="APPROVAL REQUIRED"
            prefix="Risk"
            title="At least one capability needs approval before live use."
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5">
        <h2 className="truncate text-sm font-semibold text-foreground" data-testid="eaos-blueprints-card-title">
          {redactSecretLikeText(entry.title)}
        </h2>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground" data-testid="eaos-blueprints-card-ref">
          {safeRef}
        </p>
      </div>
      <p
        className="text-xs text-muted-foreground line-clamp-3"
        data-testid="eaos-blueprints-card-description"
      >
        {description}
      </p>
      <dl className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <div className="flex flex-col">
          <dt className="uppercase tracking-wide">Skills required</dt>
          <dd className="text-foreground tabular-nums">{entry.requiredSkillRefs.length}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="uppercase tracking-wide">Secret inputs</dt>
          <dd className="text-foreground tabular-nums">{entry.requiredSecretInputs.length}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="uppercase tracking-wide">Permission policies</dt>
          <dd className="text-foreground tabular-nums">{posture.totalPolicies}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="uppercase tracking-wide">Daily run cap</dt>
          <dd className="text-foreground tabular-nums">{entry.budget.maxRunsPerDay}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Link
          to={`/eaos/blueprints/${encodeURIComponent(entry.ref)}`}
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-blueprints-card-detail-link"
        >
          Open detail workbench →
        </Link>
        <span className="text-muted-foreground">No live action on this surface.</span>
      </div>
    </li>
  );
}
