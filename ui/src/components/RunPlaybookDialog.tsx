import { useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RunPlaybookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playbookName: string;
  onRun: (input: { name: string; repoUrl?: string }) => void;
  isPending?: boolean;
}

export function RunPlaybookDialog({
  open,
  onOpenChange,
  playbookName,
  onRun,
  isPending,
}: RunPlaybookDialogProps) {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");

  function reset() {
    setName("");
    setRepoUrl("");
  }

  function handleClose(isOpen: boolean) {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  }

  function handleRun() {
    onRun({
      name: name.trim() || playbookName,
      repoUrl: repoUrl.trim() || undefined,
    });
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-4 w-4" />
            Run: {playbookName}
          </DialogTitle>
          <DialogDescription>
            This will create a project, goal, and tasks for each step. Agents will pick up their assigned tasks automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Project Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={playbookName}
              className="mt-1"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              A project and library folder will be created with this name.
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Repository URL (optional)
            </label>
            <Input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git"
              className="mt-1"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              If provided, agents will work in a workspace connected to this repo.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button onClick={handleRun} disabled={isPending}>
            <Play className="h-3.5 w-3.5 mr-1.5" />
            {isPending ? "Starting..." : "Run Playbook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
