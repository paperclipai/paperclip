import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  ExternalLink,
  Pencil,
  Trash2,
} from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { knowledgeApi } from "../api/knowledge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { getKnowledgeAuthorshipLabels } from "../lib/knowledge-metadata";
import { EmptyState } from "../components/EmptyState";
import { KnowledgeDeleteDialog } from "../components/KnowledgeDeleteDialog";
import { KnowledgeEditorDialog } from "../components/KnowledgeEditorDialog";
import { KnowledgeDetailCardHeader } from "../components/KnowledgeDetailCardHeader";
import { KnowledgeKindBadge } from "../components/KnowledgeKindBadge";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDateTime } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";

export function KnowledgeDetail() {
  const { knowledgeItemId } = useParams<{ knowledgeItemId: string }>();
  const navigate = useNavigate();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const knowledgeQuery = useQuery({
    queryKey: queryKeys.knowledge.detail(knowledgeItemId!),
    queryFn: () => knowledgeApi.get(knowledgeItemId!),
    enabled: !!knowledgeItemId,
  });

  const item = knowledgeQuery.data ?? null;
  const companyId = item?.companyId ?? selectedCompanyId ?? null;

  const { data: agents } = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : ["agents", "knowledge-detail-pending-company"],
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const authorship = item
    ? getKnowledgeAuthorshipLabels(item, {
        agents,
        currentUserId,
      })
    : null;

  useEffect(() => {
    if (!item?.companyId || item.companyId === selectedCompanyId) return;
    setSelectedCompanyId(item.companyId, { source: "route_sync" });
  }, [item?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Knowledge", href: "/knowledge" },
      { label: item?.title ?? knowledgeItemId ?? "Knowledge item" },
    ]);
  }, [item?.title, knowledgeItemId, setBreadcrumbs]);

  if (knowledgeQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (knowledgeQuery.error) {
    return (
      <p className="text-sm text-destructive">{knowledgeQuery.error.message}</p>
    );
  }

  if (!item) {
    return <EmptyState icon={BookOpen} message="Knowledge item not found." />;
  }

  return (
    <>
      <div className="space-y-8">
        <div className="flex flex-col gap-5 pt-2 md:flex-row md:items-start md:justify-between md:pt-3">
          <div className="min-w-0 space-y-4">
            <Button
              asChild
              variant="ghost"
              size="xs"
              className="w-fit px-0 text-muted-foreground hover:text-foreground"
            >
              <Link to="/knowledge">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to library
              </Link>
            </Button>
            <div className="flex items-center gap-2">
              <KnowledgeKindBadge kind={item.kind} />
              <span className="text-xs text-muted-foreground">
                Updated {timeAgo(item.updatedAt)}
              </span>
            </div>
            <div className="min-w-0 space-y-3">
              <h1 className="text-2xl font-semibold tracking-tight break-words [overflow-wrap:anywhere]">
                {item.title}
              </h1>
              {item.summary && (
                <p className="max-w-3xl text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
                  {item.summary}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setEditorOpen(true)}>
              <Pencil className="h-4 w-4" />
              Edit
            </Button>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px] xl:items-start">
          <Card className="gap-0 self-start py-0">
            <KnowledgeDetailCardHeader
              title="Content"
              description="Full shared context for future issue runs."
            />
            <CardContent className="py-6">
              {item.kind === "note" && item.body ? (
                <div className="rounded-lg border border-border bg-muted/20 p-5">
                  <p className="max-w-4xl whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-7 text-foreground/95">
                    {item.body}
                  </p>
                </div>
              ) : null}

              {item.kind === "url" && item.sourceUrl ? (
                <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-5">
                  <p className="text-sm text-muted-foreground">
                    This knowledge item points to an external reference.
                  </p>
                  <Button asChild variant="outline" className="w-fit">
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                      Open source URL
                    </a>
                  </Button>
                  <p className="text-sm break-all text-muted-foreground">
                    {item.sourceUrl}
                  </p>
                </div>
              ) : null}

              {item.kind === "asset" ? (
                <div className="rounded-lg border border-border bg-muted/20 p-5 text-sm text-muted-foreground space-y-2">
                  <p>Asset-backed knowledge item.</p>
                  <p className="break-words [overflow-wrap:anywhere]">
                    {item.asset?.originalFilename ??
                      item.asset?.assetId ??
                      item.assetId ??
                      "Unknown asset"}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="gap-0 self-start py-0">
            <KnowledgeDetailCardHeader
              title="Details"
              description="Metadata for this shared knowledge item."
            />
            <CardContent className="space-y-4 py-6 text-sm">
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Kind
                </div>
                <KnowledgeKindBadge kind={item.kind} />
              </div>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Created by
                </div>
                <div>{authorship?.createdBy ?? "Unknown"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Last updated by
                </div>
                <div>{authorship?.updatedBy ?? "Unknown"}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Created
                </div>
                <div>{formatDateTime(item.createdAt)}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Updated
                </div>
                <div>{formatDateTime(item.updatedAt)}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Knowledge ID
                </div>
                <div className="font-mono text-xs break-all text-muted-foreground">
                  {item.id}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <KnowledgeEditorDialog
        item={item}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />
      <KnowledgeDeleteDialog
        item={item}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => navigate("/knowledge")}
      />
    </>
  );
}
