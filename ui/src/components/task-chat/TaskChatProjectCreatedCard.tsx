import { FolderKanban, GitBranch } from "lucide-react";
import { Link } from "@/lib/router";
import type { TaskChatProjectCreatedItem } from "./task-chat-model";

export function TaskChatProjectCreatedCard({ item }: { item: TaskChatProjectCreatedItem }) {
  return (
    <article className="rounded-lg border border-border bg-card p-3" aria-label={`Project created: ${item.name}`}>
      <div className="flex items-start gap-3">
        <FolderKanban className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs text-muted-foreground">Project created</p>
          <Link to={`/projects/${item.projectId}`} className="break-words text-sm font-medium hover:underline focus-visible:underline">{item.name}</Link>
          {item.description && <p className="line-clamp-3 text-sm text-muted-foreground">{item.description}</p>}
          {item.repositories.length > 0 && <ul className="space-y-1 pt-1">
            {item.repositories.map(repo => <li key={repo.id} className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <a className="truncate hover:underline focus-visible:underline" href={repo.url} target="_blank" rel="noreferrer">{repo.name}</a>
            </li>)}
          </ul>}
        </div>
      </div>
    </article>
  );
}
