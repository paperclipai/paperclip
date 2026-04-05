import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { blogRunsApi } from "../api/blogRuns";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { useToast } from "../context/ToastContext";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface NewBlogRunDialogProps {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewBlogRunDialog({ companyId, open, onOpenChange }: NewBlogRunDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [projectId, setProjectId] = useState("");
  const [topic, setTopic] = useState("");
  const [issueId, setIssueId] = useState("");
  const [vertical, setVertical] = useState("ai-tech");

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: open && Boolean(companyId),
  });

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  );

  const createRun = useMutation({
    mutationFn: async () => {
      if (!projectId || !topic.trim()) throw new Error("Project and topic are required");
      return blogRunsApi.create(projectId, {
        topic: topic.trim(),
        issueId: issueId.trim() || null,
        lane: "publish",
        targetSite: "fluxaivory.com",
        approvalMode: "manual",
        publishMode: "dry_run",
        contextJson: {
          verticalKey: vertical,
          topic,
          source: "paperclip_manual_create",
        },
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.blogRuns.list(companyId, "active", 5) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.blogRuns.list(companyId, "active", 20) }),
      ]);
      pushToast({ title: "Blog run created", tone: "success" });
      setTopic("");
      setIssueId("");
      onOpenChange(false);
    },
    onError: (error) => {
      pushToast({ title: error instanceof Error ? error.message : "Failed to create blog run", tone: "error" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Blog Run</DialogTitle>
          <DialogDescription>
            Create a Paperclip-native blog run without using the legacy board-app bridge.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Project</label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {sortedProjects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Topic</label>
            <Input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="Article topic"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Issue ID (optional)</label>
            <Input
              value={issueId}
              onChange={(event) => setIssueId(event.target.value)}
              placeholder="Linked issue UUID"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Vertical</label>
            <Select value={vertical} onValueChange={setVertical}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ai-tech">AI Tech</SelectItem>
                <SelectItem value="market-strategy">Market Strategy</SelectItem>
                <SelectItem value="consumer-ai">Consumer AI</SelectItem>
                <SelectItem value="risk-privacy">Risk Privacy</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter showCloseButton>
          <Button
            onClick={() => createRun.mutate()}
            disabled={createRun.isPending || !projectId || !topic.trim()}
          >
            Create run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
