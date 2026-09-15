import type { Issue, WorkFolderScope } from "@paperclipai/shared";
import { WorkFolderBrowser } from "@/components/WorkFolderBrowser";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type TaskContext = Pick<Issue, "id" | "companyId" | "assigneeAgentId" | "responsibleUserId" | "projectId">;

export function CachedTaskFilesButton({ issue, currentUserId }: { issue: TaskContext; currentUserId?: string }) {
  const folders: { scope: WorkFolderScope; label: string; ownerId: string | null }[] = [
    { scope: "task", label: "Task", ownerId: issue.id },
    { scope: "project", label: "Project", ownerId: issue.projectId },
    { scope: "agent", label: "Agent", ownerId: issue.assigneeAgentId },
    { scope: "user", label: "Responsible user", ownerId: issue.responsibleUserId },
  ];
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="text-sm text-primary hover:underline">View cached files</button>
      </DialogTrigger>
      <DialogContent className="flex h-(--sz-calc-3) w-(--sz-calc-4) max-w-(--sz-calc-5) flex-col overflow-hidden sm:w-(--sz-94vw) sm:max-w-(--sz-1280px)">
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle>Cached task files</DialogTitle>
          <DialogDescription>
            Saved copies for this task’s current context, not the live sandbox filesystem. Changes are saved every three minutes and when a run ends, so these copies may be behind. Repository checkpoints are not browsable here.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="task" className="min-h-0 flex-1">
          <TabsList className="max-w-full shrink-0 overflow-x-auto overflow-y-hidden" aria-label="Cached file scope">
            {folders.map(({ scope, label }) => <TabsTrigger key={scope} value={scope}>{label}</TabsTrigger>)}
          </TabsList>
          {folders.map(({ scope, label, ownerId }) => (
            <TabsContent key={scope} value={scope} className="flex min-h-0 flex-col gap-3 overflow-auto">
              <p className="text-xs text-muted-foreground">Cached sandbox folder: [sandbox home]/{scope}/ · Select files to move to trash; restore them from the Trash tab</p>
              {!ownerId ? (
                <p className="text-sm text-muted-foreground">No {label.toLowerCase()} is bound to this task. This folder is empty and unbound.</p>
              ) : scope === "user" && ownerId !== currentUserId ? (
                <p className="text-sm text-muted-foreground">These cached files are private to the responsible user.</p>
              ) : (
                <WorkFolderBrowser key={`${issue.companyId}:${scope}:${ownerId}`} owner={{ companyId: issue.companyId, scope, ownerId }} readOnly allowTrashActions fillHeight />
              )}
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
