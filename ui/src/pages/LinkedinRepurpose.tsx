import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Recycle } from "lucide-react";
import { blogApi } from "../api/agnbBlog";
import { linkedinQueueApi, type ExtractedPost } from "../api/agnbLinkedinQueue";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

export function LinkedinRepurpose() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "LinkedIn" }, { label: "Repurpose" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.blogDrafts, queryFn: () => blogApi.drafts() });
  const [busy, setBusy] = useState<string | null>(null);
  const [posts, setPosts] = useState<ExtractedPost[]>([]);
  const [queued, setQueued] = useState<Set<number>>(new Set());

  const extract = async (id: string) => {
    setBusy(id); setPosts([]); setQueued(new Set());
    try { setPosts(await linkedinQueueApi.extract(id)); }
    catch (e) { alert(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(null); }
  };
  const queue = async (i: number, p: ExtractedPost) => {
    await linkedinQueueApi.addPost({ content: `${p.hook}\n\n${p.body}\n\n${p.cta}`, source_type: "repurpose" }).catch((e) => alert(e instanceof Error ? e.message : "Failed"));
    setQueued((s) => new Set(s).add(i));
  };

  return (
    <div className="space-y-4">
      <AgnbSubnav group="linkedinQueue" />
      <h1 className="text-lg font-semibold">Repurpose</h1>
      <p className="text-xs text-muted-foreground">Extract LinkedIn posts from a blog, then queue them.</p>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Recycle} message="No blogs to repurpose." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.slice(0, 30).map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
              <span className="truncate">{d.title}</span>
              <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground"><Badge variant="outline">{d.status}</Badge>{relativeTime(d.created_at)}
                <Button size="sm" variant="outline" onClick={() => extract(d.id)} disabled={busy === d.id}>{busy === d.id ? "Extracting…" : "Extract"}</Button>
              </span>
            </div>
          ))}
        </div>
      )}
      {posts.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Extracted posts ({posts.length})</h2>
          {posts.map((p, i) => (
            <div key={i} className="rounded-md border border-border p-2.5 text-sm">
              <p className="whitespace-pre-wrap"><strong>{p.hook}</strong>{"\n"}{p.body}{"\n"}<em>{p.cta}</em></p>
              <div className="mt-1 flex justify-end">
                <Button size="sm" onClick={() => queue(i, p)} disabled={queued.has(i)}>{queued.has(i) ? "Queued ✓" : "Queue"}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
