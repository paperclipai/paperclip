import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ClientProject } from "@paperclipai/shared";
import { CLIENT_PROJECT_TYPES, CLIENT_PROJECT_BILLING_TYPES } from "@paperclipai/shared";
import { clientsApi } from "../api/clients";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface LinkClientProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  companyId: string;
  editingProject?: ClientProject;
}

export function LinkClientProjectDialog({ open, onOpenChange, clientId, companyId, editingProject }: LinkClientProjectDialogProps) {
  const queryClient = useQueryClient();
  const mode = editingProject ? "edit" : "create";

  const [projectId, setProjectId] = useState("");
  const [projectNameOverride, setProjectNameOverride] = useState("");
  const [projectType, setProjectType] = useState("");
  const [billingType, setBillingType] = useState("");
  const [amountCents, setAmountCents] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId && open,
  });

  const createLink = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      clientsApi.createProject(clientId, data),
  });

  const updateLink = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      clientsApi.updateProject(editingProject!.id, data),
  });

  const activeMutation = mode === "edit" ? updateLink : createLink;

  function reset() {
    setProjectId("");
    setProjectNameOverride("");
    setProjectType("");
    setBillingType("");
    setAmountCents("");
    setStartDate("");
    setEndDate("");
    setDescription("");
    setTagsInput("");
    setTags([]);
  }

  useEffect(() => {
    if (open && editingProject) {
      setProjectId(editingProject.projectId);
      setProjectNameOverride(editingProject.projectNameOverride ?? "");
      setProjectType(editingProject.projectType ?? "");
      setBillingType(editingProject.billingType ?? "");
      setAmountCents(
        editingProject.amountCents != null ? (editingProject.amountCents / 100).toString() : "",
      );
      setStartDate(
        editingProject.startDate ? new Date(editingProject.startDate).toISOString().slice(0, 10) : "",
      );
      setEndDate(
        editingProject.endDate ? new Date(editingProject.endDate).toISOString().slice(0, 10) : "",
      );
      setDescription(editingProject.description ?? "");
      setTags(editingProject.tags ?? []);
      setTagsInput("");
    } else if (open && !editingProject) {
      reset();
    }
  }, [open, editingProject]);

  function addTag() {
    const tag = tagsInput.trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
    }
    setTagsInput("");
  }

  function handleTagKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag();
    }
  }

  async function handleSubmit() {
    if (!projectId) return;
    try {
      const data: Record<string, unknown> = {};
      if (mode === "create") data.projectId = projectId;
      if (projectNameOverride.trim()) data.projectNameOverride = projectNameOverride.trim();
      else data.projectNameOverride = null;
      if (projectType) data.projectType = projectType;
      else data.projectType = null;
      if (billingType) data.billingType = billingType;
      else data.billingType = null;
      if (amountCents) data.amountCents = Math.round(parseFloat(amountCents) * 100);
      else data.amountCents = null;
      if (startDate) data.startDate = startDate;
      else data.startDate = null;
      if (endDate) data.endDate = endDate;
      else data.endDate = null;
      if (description.trim()) data.description = description.trim();
      else data.description = null;
      data.tags = tags;

      await activeMutation.mutateAsync(data);
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.projects(clientId) });
      reset();
      onOpenChange(false);
    } catch {
      // error surfaced via activeMutation.isError
    }
  }

  const activeProjects = (projects ?? []).filter((p) => !p.archivedAt);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent showCloseButton={false} className="p-0 gap-0 sm:max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">
            {mode === "edit" ? "Edit Project Link" : "Link Project"}
          </span>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={() => { reset(); onOpenChange(false); }}>
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="px-4 py-3 space-y-3">
          {/* Project selector */}
          <div className="space-y-2">
            <Label>Project *</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={mode === "edit"}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a project..." />
              </SelectTrigger>
              <SelectContent>
                {activeProjects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Display Name Override</Label>
              <Input
                placeholder="Custom project name"
                value={projectNameOverride}
                onChange={(e) => setProjectNameOverride(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Project Type</Label>
              <Select value={projectType} onValueChange={setProjectType}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {CLIENT_PROJECT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Billing Type</Label>
              <Select value={billingType} onValueChange={setBillingType}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {CLIENT_PROJECT_BILLING_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t === "monthly" ? "Monthly" : "One-time"}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Amount (R$)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={amountCents}
                onChange={(e) => setAmountCents(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Start Date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>End Date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              placeholder="Project summary..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Tags */}
          <div className="space-y-2">
            <Label>Tags (tech stack)</Label>
            <div className="flex items-center gap-2">
              <Input
                className="flex-1"
                placeholder="Type and press Enter..."
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                onBlur={addTag}
              />
            </div>
            {tags.length > 0 && (
              <div className="flex gap-1 flex-wrap mt-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono"
                  >
                    {tag}
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setTags(tags.filter((t) => t !== tag))}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {activeMutation.isError ? (
            <p className="text-xs text-destructive">
              {mode === "edit" ? "Failed to update project link." : "Failed to link project."}
            </p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={!projectId || activeMutation.isPending}
            onClick={handleSubmit}
          >
            {activeMutation.isPending
              ? (mode === "edit" ? "Saving..." : "Linking...")
              : (mode === "edit" ? "Save Changes" : "Link project")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
