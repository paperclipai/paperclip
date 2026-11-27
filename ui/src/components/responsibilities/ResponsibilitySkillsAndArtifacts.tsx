import type { ReactNode } from "react";
import type { Agent, CompanyArtifact, ResponsibilitySkillSummary } from "@paperclipai/shared";
import { RESPONSIBILITY_ARTIFACT_COUNT_LIMIT } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { ArtifactSingleTile, ArtifactTileGrid, subjectFromCompanyArtifact } from "@/components/artifacts/v1";
import { SkillCardIcon } from "@/components/SkillCardIcon";
import { Card } from "@/components/ui/card";
import { useArtifactsV1Enabled } from "@/hooks/useArtifactsV1Enabled";
import { skillRoute } from "@/lib/company-skill-routes";
import { Link } from "@/lib/router";
import { issueUrl } from "@/lib/utils";

function SectionHeading({ id, title, count, question, action }: { id: string; title: string; count: number; question: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 id={id} className="text-base font-semibold text-foreground">
          {title} <span className="text-sm font-normal tabular-nums text-muted-foreground">{count}</span>
        </h2>
        <p className="text-sm text-muted-foreground">{question}</p>
      </div>
      {action}
    </div>
  );
}

/** The agents that hold a skill, by avatar and name. */
function Holders({ agentIds, agentsById }: { agentIds: readonly string[]; agentsById: ReadonlyMap<string, Agent> }) {
  if (agentIds.length === 0) return null;
  const names = agentIds.map((id) => agentsById.get(id)?.name ?? "An agent");
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" aria-label={`Held by ${names.join(", ")}`}>
      <span className="flex shrink-0 -space-x-1" aria-hidden="true">
        {agentIds.slice(0, 3).map((id) => (
          <AgentAvatar key={id} agent={agentsById.get(id) ?? { id }} name={agentsById.get(id)?.name} size={16} />
        ))}
      </span>
      <span className="truncate" aria-hidden="true">{names.join(", ")}</span>
    </span>
  );
}

/**
 * The skills under a responsibility, as a grid of cards: those filed here by
 * hand (which can be removed), and those held by the agents working under it
 * (the agents assigned its tasks and routines and the leads of its projects).
 */
export function ResponsibilitySkills({
  skills,
  agentsById,
  addControl,
  removeControl,
}: {
  skills: readonly ResponsibilitySkillSummary[];
  agentsById: ReadonlyMap<string, Agent>;
  /** Files a skill here; absent where the page cannot change it. */
  addControl?: ReactNode;
  /** Removes a filed skill; null for one that is only held by an agent. */
  removeControl?: (skill: ResponsibilitySkillSummary) => ReactNode;
}) {
  return (
    <section aria-labelledby="responsibility-skills-heading" className="flex flex-col gap-2">
      <SectionHeading
        id="responsibility-skills-heading"
        title="Skills"
        count={skills.length}
        question="What does this need, and what can the agents working on it do?"
        action={addControl}
      />
      {skills.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="responsibility-skills">
          {skills.map((skill) => (
            <li key={skill.id} className="min-w-0">
              <Card elevation="low" className="h-full gap-3 px-4 py-4">
                <Link
                  to={skillRoute(skill)}
                  className="flex min-w-0 items-start gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <SkillCardIcon card={skill} size={32} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-foreground underline-offset-4 hover:underline">{skill.name}</span>
                    {skill.tagline || skill.description ? (
                      <span className="line-clamp-2 text-xs text-muted-foreground">{skill.tagline || skill.description}</span>
                    ) : null}
                  </span>
                </Link>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  {skill.agentIds.length > 0 ? (
                    <Holders agentIds={skill.agentIds} agentsById={agentsById} />
                  ) : (
                    <span className="text-xs text-muted-foreground">Filed here</span>
                  )}
                  {skill.linkId ? removeControl?.(skill) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No skills yet. Add one this needs, or they appear here from the agents doing the work: the ones
          assigned its tasks and routines, and the leads of its projects.
        </p>
      )}
    </section>
  );
}

/** "Showing the newest 50 of 312", or "of 1,000 or more" once the count stops. */
export function artifactsTruncationNote(shown: number, total: number): string {
  const of = total >= RESPONSIBILITY_ARTIFACT_COUNT_LIMIT
    ? `${RESPONSIBILITY_ARTIFACT_COUNT_LIMIT.toLocaleString("en-US")} or more`
    : total.toLocaleString("en-US");
  return `Showing the newest ${shown} of ${of}.`;
}

/**
 * Everything the tasks under a responsibility produced, newest first, as a
 * grid of the Artifacts page's own cards. Each opens in the task that made it.
 */
export function ResponsibilityArtifacts({
  artifacts,
  total,
  truncated,
}: {
  artifacts: readonly CompanyArtifact[];
  total: number;
  truncated: boolean;
}) {
  const { enabled: v1 } = useArtifactsV1Enabled();
  return (
    <section aria-labelledby="responsibility-artifacts-heading" className="flex flex-col gap-3">
      <SectionHeading
        id="responsibility-artifacts-heading"
        title="Artifacts"
        count={total}
        question="What has the work produced? Newest first; each opens in the task that made it."
      />
      {artifacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing produced yet. Documents, files and other output from the tasks under this responsibility collect here.
        </p>
      ) : v1 ? (
        <ArtifactTileGrid testId="responsibility-artifacts">
          {artifacts.map((artifact) => (
            <ArtifactSingleTile key={`${artifact.source}:${artifact.id}`} subject={subjectFromCompanyArtifact(artifact)} to={artifact.href} />
          ))}
        </ArtifactTileGrid>
      ) : (
        <ul className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3" data-testid="responsibility-artifacts">
          {artifacts.map((artifact) => (
            <li key={`${artifact.source}:${artifact.id}`} className="flex min-w-0 flex-col gap-1">
              <ArtifactCard artifact={artifact} />
              <Link to={issueUrl(artifact.issue)} className="truncate px-1 text-xs text-muted-foreground underline-offset-4 hover:underline">
                <span className="font-mono">{artifact.issue.identifier}</span> {artifact.issue.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {truncated ? <p className="text-xs text-muted-foreground">{artifactsTruncationNote(artifacts.length, total)}</p> : null}
    </section>
  );
}
