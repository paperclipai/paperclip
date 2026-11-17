import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileText, Loader2, Wrench } from "lucide-react";
import { companySkillsApi } from "@/api/companySkills";
import { MarkdownBody } from "@/components/MarkdownBody";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { parseFrontmatterMarkdown } from "@paperclipai/shared";

export function TaskSkillPanel({ companyId, skillId }: { companyId: string; skillId: string }) {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: queryKeys.companySkills.detail(companyId, skillId),
    queryFn: () => companySkillsApi.detail(companyId, skillId),
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });
  const view = useQueryView(query);
  if (query.isLoading || view.kind === "reconnecting") {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading skill…
      </div>
    );
  }
  if (view.kind === "error") {
    if (view.errorKind === "not_found") {
      return <div className="py-8 text-sm text-muted-foreground" role="status">Skill no longer available.</div>;
    }
    if (view.errorKind === "forbidden") {
      return <div className="py-8 text-sm text-muted-foreground" role="alert">You do not have access to this skill.</div>;
    }
    return (
      <div className="py-6">
        <QueryErrorState error={query.error} action="load the skill" onRetry={view.retry} retrying={view.isFetching} />
      </div>
    );
  }
  if (!query.data) {
    return <div className="py-8 text-sm text-muted-foreground" role="status">Skill no longer available.</div>;
  }
  const skill = query.data;
  const previewMarkdown = parseFrontmatterMarkdown(skill.markdown).body;
  return (
    <article className="space-y-4">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wrench className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-lg font-semibold">{skill.name}</h2>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/skills/studio/${encodeURIComponent(skill.id)}`)}
          >
            <ExternalLink className="mr-1.5 size-3.5" aria-hidden />
            Open in Skill Studio
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {skill.slug} · {skill.currentVersion ? `Revision ${skill.currentVersion.revisionNumber}` : "Current version"}
        </p>
      </header>
      {skill.description ? <p className="text-sm text-muted-foreground">{skill.description}</p> : null}
      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <FileText className="size-3.5" aria-hidden />
          Skill instructions
        </h3>
        <MarkdownBody>{previewMarkdown || "Skill instructions are empty."}</MarkdownBody>
      </section>
    </article>
  );
}
