import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueRelationType } from "@paperclipai/shared";
import { ArrowRight, Ban, Copy, Link2, Plus, Trash2 } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { issueRelationsApi, type IssueRelationSummary } from "../api/issue-relations";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { StatusIcon } from "./StatusIcon";
import { cn } from "../lib/utils";

// Upstream's issue_relations system uses `blocks` (and its inverse
// `blocked_by`) to model task dependencies; this component adds management
// for the richer `related`/`duplicate` types as well. The server service
// maintains the inverse edges automatically — the UI only ever creates one
// direction.
const RELATION_META: Record<
  IssueRelationType,
  { label: string; icon: typeof Link2; order: number }
> = {
  blocks: { label: "Blocks", icon: ArrowRight, order: 1 },
  blocked_by: { label: "Blocked by", icon: Ban, order: 2 },
  related: { label: "Related to", icon: Link2, order: 3 },
  duplicate: { label: "Duplicate of", icon: Copy, order: 4 },
};

const SELECTABLE_TYPES: IssueRelationType[] = ["blocks", "blocked_by", "related", "duplicate"];

interface IssueRelationsProps {
  issueId: string;
  className?: string;
}

export function IssueRelations({ issueId, className }: IssueRelationsProps) {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();

  const { data: relations = [] } = useQuery({
    queryKey: queryKeys.issues.relations(issueId),
    queryFn: () => issueRelationsApi.list(issueId),
    enabled: !!issueId,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<IssueRelationType>("blocks");

  const { data: searchResults = [] } = useQuery({
    queryKey: ["issues", selectedCompanyId, "search", search],
    queryFn: () =>
      selectedCompanyId
        ? issuesApi.search(selectedCompanyId, search, undefined, 20)
        : Promise.resolve([]),
    enabled: !!selectedCompanyId && addOpen && search.length > 0,
  });

  const createRelation = useMutation({
    mutationFn: ({ relatedIssueId }: { relatedIssueId: string }) =>
      issueRelationsApi.create(issueId, { relatedIssueId, type }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.relations(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      setAddOpen(false);
      setSearch("");
    },
  });

  const deleteRelation = useMutation({
    mutationFn: (relationId: string) => issueRelationsApi.delete(issueId, relationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.relations(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    },
  });

  // Group relations by type, sorted by the defined display order.
  const grouped: Array<{ type: IssueRelationType; relations: IssueRelationSummary[] }> =
    SELECTABLE_TYPES.map((t) => ({
      type: t,
      relations: relations.filter((r) => r.type === t),
    }))
      .filter((g) => g.relations.length > 0)
      .sort((a, b) => RELATION_META[a.type].order - RELATION_META[b.type].order);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Relations
        </h3>
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-3" align="end">
            <div className="space-y-2">
              <div>
                <label className="text-xs font-medium">Type</label>
                <Select
                  value={type}
                  onValueChange={(v) => setType(v as IssueRelationType)}
                >
                  <SelectTrigger className="w-full h-8 text-sm mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SELECTABLE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {RELATION_META[t].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium">Find issue</label>
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by title or identifier…"
                  className="h-8 text-sm mt-1"
                />
              </div>
              {search.length > 0 && (
                <div className="max-h-60 overflow-y-auto border rounded-md divide-y">
                  {searchResults
                    .filter((r) => r.id !== issueId)
                    .map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => createRelation.mutate({ relatedIssueId: r.id })}
                        disabled={createRelation.isPending}
                        className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent/50"
                      >
                        <span className="text-muted-foreground font-mono text-xs mr-2">
                          {r.identifier ?? r.id.slice(0, 8)}
                        </span>
                        <span>{r.title}</span>
                      </button>
                    ))}
                  {searchResults.length === 0 && (
                    <div className="px-2 py-2 text-xs text-muted-foreground">No matches</div>
                  )}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {grouped.length === 0 ? (
        <p className="text-xs text-muted-foreground">No relations</p>
      ) : (
        grouped.map(({ type: groupType, relations: groupRelations }) => {
          const meta = RELATION_META[groupType];
          const Icon = meta.icon;
          return (
            <div key={groupType}>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Icon className="h-3 w-3" />
                {meta.label}
              </div>
              <ul className="space-y-0.5">
                {groupRelations.map((r) => (
                  <li
                    key={r.id}
                    className="group flex items-center gap-2 text-sm pl-4 pr-1 py-0.5 rounded hover:bg-accent/40"
                  >
                    <StatusIcon status={r.relatedIssue.status} className="h-3 w-3 shrink-0" />
                    <Link
                      to={`/issues/${r.relatedIssueId}`}
                      className="flex-1 min-w-0 truncate hover:underline"
                    >
                      <span className="text-muted-foreground font-mono text-xs mr-2">
                        {r.relatedIssue.identifier ?? r.relatedIssueId.slice(0, 8)}
                      </span>
                      <span>{r.relatedIssue.title}</span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => deleteRelation.mutate(r.id)}
                      disabled={deleteRelation.isPending}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                      aria-label="Remove relation"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </div>
  );
}
