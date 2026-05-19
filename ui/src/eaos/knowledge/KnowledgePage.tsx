// LET-484 working-product slice — read-only `/eaos/knowledge` zone.
//
// Knowledge in the EAOS sense is three layers:
//   1. Skills / playbook packs — backend-backed via
//      `companySkillsApi.list(companyId)`.
//   2. Per-mission design docs / evidence — already lives inside
//      `/eaos/missions/:missionRef` (Mission detail); we link there.
//   3. Cross-mission knowledge index (board-level docs, validation
//      contracts) — no first-class company-scoped backend yet. We render an
//      explicit truthful gap label naming the missing API path so QA can
//      tell preview from real.

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, BookOpen, Workflow } from "lucide-react";
import { companySkillsApi } from "@/api/companySkills";
import { useCompany } from "@/context/CompanyContext";
import { Link } from "@/lib/router";
import { EaosStateChip } from "../EaosStateChip";
import {
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_NOTE,
  NOT_CONNECTED_DATA_PREFIX,
  SHELL_POSTURE_LABEL,
  SHELL_POSTURE_PREFIX,
} from "../state-labels";
import { redactSecretLikeText } from "../secret-redact";

export function KnowledgePage() {
  const { selectedCompanyId, selectedCompany } = useCompany();

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
  const skills = skillsQuery.data ?? [];

  return (
    <section
      aria-labelledby="eaos-knowledge-title"
      className="flex flex-col gap-5"
      data-testid="eaos-knowledge-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" data-testid="eaos-knowledge-posture">
          <EaosStateChip label={SHELL_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
          {dataConnected ? (
            <EaosStateChip
              label="BACKEND-BACKED"
              prefix="Playbooks"
              title="Skill packs sourced from /api/companies/:companyId/skills"
            />
          ) : (
            <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
          )}
          <EaosStateChip
            label="PREVIEW"
            prefix="KB-index"
            title="Cross-mission knowledge index is not wired in this slice. Backend gap: GET /api/companies/:companyId/knowledge — pending."
          />
          <span
            className="text-[11px] uppercase tracking-wide text-muted-foreground"
            data-testid="eaos-knowledge-posture-note"
          >
            {dataConnected
              ? `Live read · ${selectedCompany?.name ? redactSecretLikeText(selectedCompany.name) : "current company scope"}`
              : NOT_CONNECTED_DATA_NOTE}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
          <div className="flex flex-col gap-1">
            <h1
              id="eaos-knowledge-title"
              className="text-2xl font-semibold tracking-tight text-foreground"
              data-testid="eaos-knowledge-title"
            >
              Knowledge / Playbooks
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Playbook packs are backend-backed for the current company scope. Design docs,
              validation contracts, and evidence live inside each mission until a cross-mission
              KB index is wired — open Mission detail to see the per-issue document store.
            </p>
          </div>
        </div>
      </header>

      <PlaybooksSection
        selectedCompanyId={selectedCompanyId}
        isLoading={isLoading}
        isError={isError}
        errorMessage={readErrorMessage(skillsQuery.error)}
        skills={skills}
        companyName={selectedCompany?.name ? redactSecretLikeText(selectedCompany.name) : null}
      />

      <KbIndexGapSection />

      <DocumentsGapSection />
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load skill packs.";
}

function PlaybooksSection({
  selectedCompanyId,
  isLoading,
  isError,
  errorMessage,
  skills,
  companyName,
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
  companyName: string | null;
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
          Select a company scope from the top bar to load playbook packs.
        </p>
      ) : isLoading ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground"
          data-testid="eaos-knowledge-playbooks-loading"
        >
          Loading skill packs from canonical records…
        </p>
      ) : isError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          data-testid="eaos-knowledge-playbooks-error"
        >
          <p className="font-medium">Could not load skill packs.</p>
          <p className="mt-1">{redactSecretLikeText(errorMessage)}</p>
        </div>
      ) : skills.length === 0 ? (
        <p
          className="rounded-md border border-dashed border-border bg-card p-3 text-xs text-muted-foreground"
          data-testid="eaos-knowledge-playbooks-empty"
        >
          No skill packs are visible for {companyName ?? "this company"} yet. When the company
          imports or scans a playbook it will appear here.
        </p>
      ) : (
        <ul
          className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
          data-testid="eaos-knowledge-playbooks-rows"
        >
          {skills.map((skill) => (
            <li
              key={skill.id}
              data-testid="eaos-knowledge-playbook-row"
              data-skill-id={skill.id}
              className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <EaosStateChip
                  label="BACKEND-BACKED"
                  prefix="Pack"
                  title="Skill pack record from /api/companies/:companyId/skills"
                />
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
                Attached agents · <span className="tabular-nums text-foreground">{skill.attachedAgentCount}</span>
              </p>
              <Link
                to={`/skills/${skill.key}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                data-testid="eaos-knowledge-playbook-link"
              >
                <span>Open in Kernel/Admin</span>
                <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KbIndexGapSection() {
  return (
    <section
      aria-label="Cross-mission knowledge index"
      className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-card p-3"
      data-testid="eaos-knowledge-kb-index-gap"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Workflow aria-hidden="true" className="h-4 w-4 text-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Cross-mission knowledge index</h2>
        </div>
        <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
      </div>
      <p className="text-xs text-muted-foreground">
        Temporary gap — a company-wide knowledge index endpoint does not exist yet.
      </p>
      <p className="text-[11px] text-muted-foreground">
        Backend path pending: <code>GET /api/companies/:companyId/knowledge</code>
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
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen aria-hidden="true" className="h-4 w-4 text-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Mission documents &amp; evidence</h2>
        </div>
        <EaosStateChip
          label="PREVIEW"
          prefix="Index"
          title="Cross-mission document index not wired in this slice."
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Design docs, validation contracts, and evidence are backend-backed but indexed
        per-mission. Open a mission via <Link
          to="/eaos/missions"
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-knowledge-missions-link"
        >
          Missions
        </Link>{" "}
        to see its document store, revisions, and evidence trail.
      </p>
    </section>
  );
}
