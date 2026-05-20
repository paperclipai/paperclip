// LET-484 working-product slice — read-only `/eaos/knowledge` zone.
// LET-513 §5 — adds the shared view controls (cards/list + filter).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BookOpen, Workflow } from "lucide-react";
import { companySkillsApi } from "@/api/companySkills";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { EaosPageHeader } from "../EaosPageHeader";
import {
  EaosViewControls,
  eaosMatchesFilter,
  type EaosViewMode,
} from "../EaosViewControls";
import { redactSecretLikeText } from "../secret-redact";

export function KnowledgePage() {
  const { selectedCompanyId } = useCompany();
  const [viewMode, setViewMode] = useState<EaosViewMode>("cards");
  const [filter, setFilter] = useState<string>("");

  const skillsQuery = useQuery({
    queryKey: selectedCompanyId
      ? ["companies", selectedCompanyId, "skills", "eaos-knowledge"]
      : ["companies", "__no-company__", "skills", "eaos-knowledge"],
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const isLoading = Boolean(selectedCompanyId) && skillsQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && skillsQuery.isError;
  const hasData = !isLoading && !isError && skillsQuery.isSuccess;
  const dataConnected = hasData;
  const allSkills = skillsQuery.data ?? [];
  const skills = useMemo(
    () =>
      filter
        ? allSkills.filter((skill) =>
            eaosMatchesFilter(
              `${skill.name} ${skill.description ?? ""} ${skill.key}`,
              filter,
            ),
          )
        : allSkills,
    [allSkills, filter],
  );

  return (
    <section
      aria-labelledby="eaos-knowledge-title"
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-knowledge-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <EaosPageHeader title="Knowledge" testId="eaos-knowledge-page-header" />
      <h1 id="eaos-knowledge-title" className="sr-only" data-testid="eaos-knowledge-title">
        Knowledge
      </h1>

      <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
        {selectedCompanyId && allSkills.length > 0 ? (
          <EaosViewControls
            mode={viewMode}
            onModeChange={setViewMode}
            filter={filter}
            onFilterChange={setFilter}
            filterPlaceholder="Filter playbooks…"
            testIdPrefix="eaos-knowledge"
          />
        ) : null}

        <PlaybooksSection
          selectedCompanyId={selectedCompanyId}
          isLoading={isLoading}
          isError={isError}
          errorMessage={readErrorMessage(skillsQuery.error)}
          skills={skills}
          viewMode={viewMode}
          filterActive={filter.length > 0}
          totalSkillCount={allSkills.length}
        />

        <KbIndexGapSection />

        <DocumentsGapSection />
      </div>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load playbooks.";
}

function PlaybooksSection({
  selectedCompanyId,
  isLoading,
  isError,
  errorMessage,
  skills,
  viewMode,
  filterActive,
  totalSkillCount,
}: {
  selectedCompanyId: string | null | undefined;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string;
  skills: ReadonlyArray<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    sourceType: string;
    trustLevel: string;
    attachedAgentCount: number;
  }>;
  viewMode: EaosViewMode;
  filterActive: boolean;
  totalSkillCount: number;
}) {
  return (
    <section
      aria-label="Playbook packs"
      className="flex flex-col gap-2"
      data-testid="eaos-knowledge-playbooks"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen aria-hidden="true" className="h-4 w-4 text-foreground" />
          <h2 className="text-sm font-semibold text-foreground">
            Playbook packs{" "}
            <span className="text-xs font-normal text-muted-foreground">({skills.length})</span>
          </h2>
        </div>
      </header>
      {!selectedCompanyId ? (
        <p
          role="status"
          className="rounded-md border border-dashed border-border bg-card p-3 text-xs text-muted-foreground"
          data-testid="eaos-knowledge-playbooks-no-company"
        >
          Select a company from the top bar to see its playbooks.
        </p>
      ) : isLoading ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground"
          data-testid="eaos-knowledge-playbooks-loading"
        >
          Loading playbooks…
        </p>
      ) : isError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          data-testid="eaos-knowledge-playbooks-error"
        >
          <p className="font-medium">Could not load playbooks.</p>
          <p className="mt-1">{redactSecretLikeText(errorMessage)}</p>
        </div>
      ) : skills.length === 0 ? (
        <p
          className="rounded-md border border-dashed border-border bg-card p-3 text-xs text-muted-foreground"
          data-testid={
            filterActive
              ? "eaos-knowledge-playbooks-filter-empty"
              : "eaos-knowledge-playbooks-empty"
          }
        >
          {filterActive && totalSkillCount > 0
            ? "No playbooks match the current filter."
            : "No playbooks yet. Import or scan a playbook to add it here."}
        </p>
      ) : (
        <ul
          className={
            viewMode === "list"
              ? "flex flex-col gap-1.5"
              : "grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
          }
          data-testid="eaos-knowledge-playbooks-rows"
          data-eaos-view-mode={viewMode}
        >
          {skills.map((skill) =>
            viewMode === "list" ? (
              <li
                key={skill.id}
                data-testid="eaos-knowledge-playbook-row"
                data-skill-id={skill.id}
                data-eaos-view-mode="list"
                className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-[12px]"
              >
                <span className="shrink-0 rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {skill.trustLevel}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate font-medium text-foreground"
                    data-testid="eaos-knowledge-playbook-name"
                  >
                    {redactSecretLikeText(skill.name)}
                  </p>
                  {skill.description ? (
                    <p className="truncate text-[11px] text-muted-foreground">
                      {redactSecretLikeText(skill.description)}
                    </p>
                  ) : null}
                </div>
                <span
                  className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline tabular-nums"
                  title={`${skill.attachedAgentCount} agents use this playbook`}
                >
                  {skill.attachedAgentCount} agents
                </span>
                <Link
                  to={`/skills/${skill.key}`}
                  className="shrink-0 text-[11px] font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  data-testid="eaos-knowledge-playbook-link"
                >
                  Open
                </Link>
              </li>
            ) : (
              <li
                key={skill.id}
                data-testid="eaos-knowledge-playbook-row"
                data-skill-id={skill.id}
                data-eaos-view-mode="cards"
                className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {skill.trustLevel}
                  </span>
                  <span className="rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {skill.sourceType}
                  </span>
                </div>
                <div className="flex min-w-0 flex-col">
                  <p
                    className="truncate text-sm font-medium text-foreground"
                    data-testid="eaos-knowledge-playbook-name"
                  >
                    {redactSecretLikeText(skill.name)}
                  </p>
                  {skill.description ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {redactSecretLikeText(skill.description)}
                    </p>
                  ) : null}
                </div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Attached agents ·{" "}
                  <span className="tabular-nums text-foreground">
                    {skill.attachedAgentCount}
                  </span>
                </p>
                <Link
                  to={`/skills/${skill.key}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  data-testid="eaos-knowledge-playbook-link"
                >
                  <span>Open playbook</span>
                  <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
                </Link>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function KbIndexGapSection() {
  return (
    <section
      aria-label="Cross-mission knowledge"
      className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-card p-3"
      data-testid="eaos-knowledge-kb-index-gap"
    >
      <div className="flex items-center gap-2">
        <Workflow aria-hidden="true" className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Cross-mission knowledge</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Company-wide knowledge search is coming soon.
      </p>
    </section>
  );
}

function DocumentsGapSection() {
  return (
    <section
      aria-label="Per-mission documents"
      className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-card p-3"
      data-testid="eaos-knowledge-documents-pointer"
    >
      <div className="flex items-center gap-2">
        <BookOpen aria-hidden="true" className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Mission documents &amp; evidence</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Design docs, validation contracts, and evidence live inside each mission. Open a mission
        via <Link
          to="/eaos/missions"
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-knowledge-missions-link"
        >
          Missions
        </Link>{" "}
        to see its document store and revisions.
      </p>
    </section>
  );
}
