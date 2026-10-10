import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanySkillCoverageCell,
} from "@paperclipai/shared";
import { Grid2x2, Search } from "lucide-react";
import { agentsApi } from "../../api/agents";
import { companySkillsApi } from "../../api/companySkills";
import { EmptyState } from "../../components/EmptyState";
import { PageSkeleton } from "../../components/PageSkeleton";
import { queryKeys } from "../../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

const AGENT_ROW_PAGE_SIZE = 25;

type CoverageCellKind = "desired" | "gap" | "unsupported";

function cellKind(cell: CompanySkillCoverageCell | undefined): CoverageCellKind {
  if (!cell) return "gap";
  if (cell.desired) return "desired";
  if (cell.syncMode === "unsupported") return "unsupported";
  return "gap";
}

function cellKey(agentId: string, skillKey: string) {
  return `${agentId}:${skillKey}`;
}

export function CompanySkillsCoverageTab({ companyId }: { companyId: string }) {
  return <SkillCoverageMatrix companyId={companyId} />;
}

export function SkillCoverageMatrix({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [agentRowLimit, setAgentRowLimit] = useState(AGENT_ROW_PAGE_SIZE);
  const q = search.trim();

  const coverageQuery = useQuery({
    queryKey: queryKeys.companySkills.coverage(companyId, { q, missingOnly: false }),
    queryFn: () => companySkillsApi.coverage(companyId, q ? { q } : {}),
    enabled: Boolean(companyId),
  });

  const attachSkill = useMutation({
    mutationFn: async ({
      agentId,
      skillKey,
    }: {
      agentId: string;
      skillKey: string;
    }) => agentsApi.syncSkills(agentId, [skillKey], "add", companyId),
    onSuccess: async (_snapshot, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: ["company-skills", companyId, "coverage"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.skills(variables.agentId) }),
      ]);
    },
  });

  const payload = coverageQuery.data;
  const cellMap = useMemo(() => {
    const next = new Map<string, CompanySkillCoverageCell>();
    for (const cell of payload?.cells ?? []) {
      next.set(cellKey(cell.agentId, cell.skillKey), cell);
    }
    return next;
  }, [payload]);

  const visibleCells = useMemo(() => {
    const cells = payload?.cells ?? [];
    return missingOnly ? cells.filter((cell) => !cell.desired) : cells;
  }, [missingOnly, payload]);

  const visibleAgentIds = useMemo(
    () => new Set(visibleCells.map((cell) => cell.agentId)),
    [visibleCells],
  );
  const visibleSkillKeys = useMemo(
    () => new Set(visibleCells.map((cell) => cell.skillKey)),
    [visibleCells],
  );

  const visibleAgents = useMemo(
    () => (payload?.agents ?? []).filter((agent) => !missingOnly || visibleAgentIds.has(agent.id)),
    [missingOnly, payload, visibleAgentIds],
  );
  const visibleSkills = useMemo(
    () => (payload?.skills ?? []).filter((skill) => !missingOnly || visibleSkillKeys.has(skill.key)),
    [missingOnly, payload, visibleSkillKeys],
  );

  const renderedAgents = visibleAgents.slice(0, agentRowLimit);

  function attachGap(agentId: string, skillKey: string) {
    if (attachSkill.isPending) return;
    attachSkill.mutate({ agentId, skillKey });
  }

  const summary = payload?.summary;
  const attaching = attachSkill.isPending;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Skills coverage">
      <div className="border-b border-border px-4 py-5">
        <h1 className="text-2xl font-semibold">Coverage</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Desired attachments from the company library. This view does not probe live adapter state.
        </p>
        {summary ? (
          <dl className="mt-4 flex flex-wrap gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Agents</dt>
              <dd className="font-medium">{summary.agentCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Skills</dt>
              <dd className="font-medium">{summary.skillCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Desired</dt>
              <dd className="font-medium">{summary.desiredCellCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Gaps</dt>
              <dd className="font-medium">{summary.gapCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Unsupported</dt>
              <dd className="font-medium">{summary.unsupportedAgentCount}</dd>
            </div>
          </dl>
        ) : null}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setAgentRowLimit(AGENT_ROW_PAGE_SIZE);
              }}
              placeholder="Filter agents or skills"
              className="h-8 pl-8"
              aria-label="Filter agents or skills"
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <Checkbox
              checked={missingOnly}
              onCheckedChange={(checked) => {
                setMissingOnly(checked === true);
                setAgentRowLimit(AGENT_ROW_PAGE_SIZE);
              }}
              aria-label="Missing only"
            />
            Missing only
          </label>
        </div>
        {attachSkill.isError ? (
          <p className="mt-3 text-sm text-destructive">
            {attachSkill.error instanceof Error ? attachSkill.error.message : "Failed to attach skill"}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {coverageQuery.isLoading ? (
          <PageSkeleton variant="list" />
        ) : coverageQuery.error ? (
          <EmptyState
            icon={Grid2x2}
            message={coverageQuery.error instanceof Error ? coverageQuery.error.message : "Could not load coverage."}
          />
        ) : !payload || (payload.skills.length === 0 && payload.agents.length === 0) ? (
          <EmptyState
            icon={Grid2x2}
            message={q
              ? "No agents or skills match your search."
              : "No agents or installed skills to show."}
          />
        ) : visibleAgents.length === 0 || visibleSkills.length === 0 ? (
          <EmptyState icon={Grid2x2} message="No coverage cells match the current filters." />
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Agent skill coverage</caption>
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 bg-background px-3 py-2 text-left font-medium">
                      Agent
                    </th>
                    {visibleSkills.map((skill) => (
                      <th
                        key={skill.id}
                        scope="col"
                        className="px-3 py-2 text-left font-medium"
                        title={skill.key}
                      >
                        {skill.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {renderedAgents.map((agent) => (
                    <tr key={agent.id} className="border-t border-border">
                      <th scope="row" className="sticky left-0 bg-background px-3 py-2 text-left font-medium">
                        <div className="flex flex-col gap-1">
                          <Link to={`/agents/${agent.urlKey}/skills`} className="text-foreground no-underline hover:underline">
                            {agent.name}
                          </Link>
                          <span className="text-xs font-normal text-muted-foreground">{agent.role}</span>
                          {agent.syncMode === "unsupported" ? (
                            <Badge variant="outline">Unsupported</Badge>
                          ) : null}
                        </div>
                      </th>
                      {visibleSkills.map((skill) => {
                        const cell = cellMap.get(cellKey(agent.id, skill.key));
                        const kind = cellKind(cell);
                        if (missingOnly && kind === "desired") {
                          return <td key={skill.key} className="px-3 py-2" />;
                        }
                        return (
                          <td key={skill.key} className="px-3 py-2">
                            <CoverageCell
                              kind={kind}
                              skillName={skill.name}
                              agentName={agent.name}
                              pending={attaching}
                              onAttach={kind === "gap" ? () => attachGap(agent.id, skill.key) : undefined}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="flex flex-col gap-4 md:hidden">
              {renderedAgents.map((agent) => (
                <li key={agent.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Link to={`/agents/${agent.urlKey}/skills`} className="font-medium text-foreground no-underline hover:underline">
                        {agent.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{agent.role}</p>
                    </div>
                    {agent.syncMode === "unsupported" ? (
                      <Badge variant="outline">Unsupported</Badge>
                    ) : null}
                  </div>
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {visibleSkills.map((skill) => {
                      const cell = cellMap.get(cellKey(agent.id, skill.key));
                      const kind = cellKind(cell);
                      if (missingOnly && kind === "desired") return null;
                      return (
                        <li key={skill.key}>
                          <CoverageCell
                            kind={kind}
                            skillName={skill.name}
                            agentName={agent.name}
                            pending={attaching}
                            onAttach={kind === "gap" ? () => attachGap(agent.id, skill.key) : undefined}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
            {renderedAgents.length < visibleAgents.length ? (
              <div className="mt-4 flex items-center gap-3 text-sm">
                <span>Showing {renderedAgents.length} of {visibleAgents.length} agents</span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAgentRowLimit((limit) => limit + AGENT_ROW_PAGE_SIZE)}
                >
                  Show more agents
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function CoverageCell({
  kind,
  skillName,
  agentName,
  pending,
  onAttach,
}: {
  kind: CoverageCellKind;
  skillName: string;
  agentName: string;
  pending: boolean;
  onAttach?: () => void;
}) {
  if (kind === "desired") {
    return <Badge variant="secondary">Desired</Badge>;
  }
  if (kind === "unsupported") {
    return <Badge variant="outline">Unsupported</Badge>;
  }
  if (onAttach) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={onAttach}
        aria-label={`Attach ${skillName} to ${agentName}`}
      >
        Gap
      </Button>
    );
  }
  return <Badge variant="outline">Gap</Badge>;
}
