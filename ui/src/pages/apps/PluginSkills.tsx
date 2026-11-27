import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Package } from "lucide-react";
import { companySkillsApi } from "@/api/companySkills";
import { mcpSkillsApi } from "@/api/mcpSkills";
import { Button } from "@/components/ui/button";
import { describeError } from "@/api/errors";
import { QueryErrorState } from "@/components/QueryView";
import { queryKeys } from "@/lib/queryKeys";

/** Skills Paperclip applies on its own while an agent is assigned the connector (server/src/services/connector-runtime.ts). */
const BUILT_IN_SKILLS: Record<string, { name: string; description: string }> = {
  slack: { name: "slack", description: "How to read and post in Slack through the governed Slack tools." },
  agentmail: { name: "agentmail", description: "How to send, read and reply to email from an assigned inbox." },
  "browser-use-cloud": { name: "browser-use-cloud", description: "How to drive a cloud browser session for web tasks." },
  speko: { name: "speko", description: "How to place and handle phone calls with Speko." },
};

/** Catalog skills that pair with a connector. The pairing lives here until the catalog can declare it. */
const CATALOG_SKILL_IDS: Record<string, string[]> = {
  github: ["paperclipai:bundled:software-development:github-pr-workflow"],
};

const CATALOG_QUERY_KEY = ["company-skills", "catalog", "plugin-bundles"] as const;

const ROW = "flex min-h-14 items-center gap-3 px-4 py-2.5";

function SkillRow({ name, detail, children }: { name: string; detail: string; children?: ReactNode }) {
  return (
    <li className={ROW}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/5 text-foreground">
        <Package className="size-4" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate font-mono text-sm font-semibold text-foreground">{name}</p>
        <p className="truncate text-sm text-muted-foreground">{detail}</p>
      </div>
      {children}
    </li>
  );
}

/** The skills that come with a connector: built in, published by its connected server, or paired from the catalog. */
export function PluginSkills({
  companyId,
  slug,
  name,
  connectionIds,
  onNavigate,
}: {
  companyId: string;
  slug: string;
  name: string;
  connectionIds: readonly string[];
  onNavigate: (href: string) => void;
}) {
  const queryClient = useQueryClient();
  const builtIn = BUILT_IN_SKILLS[slug];
  const catalogIds = CATALOG_SKILL_IDS[slug] ?? [];
  const publishedQuery = useQuery({
    queryKey: queryKeys.mcpSkills.list(companyId),
    queryFn: () => mcpSkillsApi.list(companyId),
    enabled: connectionIds.length > 0,
  });
  const catalogQuery = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: () => companySkillsApi.catalogList(),
    enabled: catalogIds.length > 0,
  });
  const installedQuery = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId),
    enabled: catalogIds.length > 0,
  });
  const install = useMutation({
    mutationFn: (catalogSkillId: string) => companySkillsApi.installCatalog(companyId, { catalogSkillId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) }),
  });

  const published = (publishedQuery.data ?? []).filter((skill) => connectionIds.includes(skill.connectionId) && skill.status !== "unavailable");
  const catalog = (catalogQuery.data ?? []).filter((skill) => catalogIds.includes(skill.id));
  const installedKeys = new Set((installedQuery.data ?? []).map((skill) => skill.key));
  const count = (builtIn ? 1 : 0) + published.length + catalog.length;
  // A failed read is not an empty result: say so and offer a retry, and never
  // show a skill as addable while its installed state is unknown.
  // Only reads this plugin actually uses count: a disabled query can still hold another plugin's cached error.
  const failed = [
    ...(connectionIds.length > 0 ? [publishedQuery] : []),
    ...(catalogIds.length > 0 ? [catalogQuery, installedQuery] : []),
  ].filter((query) => query.error != null && query.data === undefined);
  if (count === 0 && failed.length === 0) return null;
  const installedKnown = installedQuery.data !== undefined;

  return (
    <section aria-labelledby="plugin-skills-title" className="flex flex-col gap-2">
      <h2 id="plugin-skills-title" className="flex items-baseline gap-2 px-4 text-sm text-muted-foreground">
        Skills {count > 0 ? <span className="tabular-nums">{count}</span> : null}
      </h2>
      {failed.length > 0 ? (
        <QueryErrorState
          error={failed[0].error}
          action={`load the skills that come with ${name}`}
          onRetry={() => failed.forEach((query) => void query.refetch())}
          retrying={failed.some((query) => query.isFetching)}
        />
      ) : null}
      {count > 0 ? <ul aria-label={`Skills that come with ${name}`} className="divide-y divide-border rounded-2xl bg-muted/50">
        {builtIn ? (
          <SkillRow name={builtIn.name} detail={builtIn.description}>
            <span className="shrink-0 text-xs text-muted-foreground">Added for agents assigned {name}</span>
          </SkillRow>
        ) : null}
        {published.map((skill) => (
          <SkillRow key={skill.id} name={skill.name} detail={skill.description}>
            {skill.status === "approved" ? (
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Check className="size-3.5" aria-hidden />
                Approved
              </span>
            ) : (
              <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => onNavigate("/skills")}>
                {skill.status === "pending_review" ? "Review" : "Open in Skills"}
              </Button>
            )}
          </SkillRow>
        ))}
        {catalog.map((skill) => {
          const installed = installedKeys.has(skill.key);
          const pending = install.isPending && install.variables === skill.id;
          return (
            <SkillRow key={skill.id} name={skill.name} detail={skill.description}>
              {!installedKnown ? null : installed ? (
                <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => onNavigate("/skills")}>
                  <Check aria-hidden />
                  Added · choose agents
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={pending} aria-label={`Add ${skill.name}`} onClick={() => install.mutate(skill.id)}>
                  {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Add skill
                </Button>
              )}
            </SkillRow>
          );
        })}
      </ul> : null}
      {install.error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {describeError(install.error).body}
        </p>
      ) : null}
      <p className="px-4 text-xs text-muted-foreground">Skills stay editable in Skills, where you choose which agents use them.</p>
    </section>
  );
}
