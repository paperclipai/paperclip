import { Wrench } from "lucide-react";
import type { TaskChatSkillCreatedItem } from "./task-chat-model";

export function TaskChatSkillCreatedCard({ item, onOpen }: { item: TaskChatSkillCreatedItem; onOpen?: (skillId: string, name: string) => void }) {
  return (
    <article className="rounded-lg border border-border bg-card p-3" aria-label={`Skill created: ${item.name}`}>
      <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => onOpen?.(item.skillId, item.name)}>
        <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-xs text-muted-foreground">Skill created</span>
          <span className="block break-words text-sm font-medium hover:underline focus-visible:underline">{item.name}</span>
          {item.description ? <span className="block line-clamp-3 text-sm text-muted-foreground">{item.description}</span> : null}
        </span>
      </button>
    </article>
  );
}
