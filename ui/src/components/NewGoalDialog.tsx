import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GOAL_STATUSES, GOAL_LEVELS } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { goalsApi } from "../api/goals";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { Modal } from "@heroui/react";
import { Button } from "@heroui/react";
import { Popover } from "@heroui/react";
import {
  Maximize2,
  Minimize2,
  Target,
  Layers,
} from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownEditor, type MarkdownEditorRef } from "./MarkdownEditor";
import { StatusBadge } from "./StatusBadge";

const levelLabels: Record<string, string> = {
  company: "Company",
  team: "Team",
  agent: "Agent",
  task: "Task",
};

export function NewGoalDialog() {
  const { newGoalOpen, newGoalDefaults, closeNewGoal } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("planned");
  const [level, setLevel] = useState("task");
  const [parentId, setParentId] = useState("");
  const [expanded, setExpanded] = useState(false);

  const [statusOpen, setStatusOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);

  // Apply defaults when dialog opens
  const appliedParentId = parentId || newGoalDefaults.parentId || "";

  const { data: goals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newGoalOpen,
  });

  const createGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(selectedCompanyId!) });
      reset();
      closeNewGoal();
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(selectedCompanyId, file, "goals/drafts");
    },
  });

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("planned");
    setLevel("task");
    setParentId("");
    setExpanded(false);
  }

  function handleSubmit() {
    if (!selectedCompanyId || !title.trim()) return;
    createGoal.mutate({
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      level,
      ...(appliedParentId ? { parentId: appliedParentId } : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const currentParent = (goals ?? []).find((g) => g.id === appliedParentId);

  return (
    <Modal.Backdrop
      isOpen={newGoalOpen}
      onOpenChange={(open: boolean) => {
        if (!open) {
          reset();
          closeNewGoal();
        }
      }}
    >
      <Modal.Container size={expanded ? "lg" : "md"}>
        <Modal.Dialog>
          <div
            className="p-0 gap-0"
            onKeyDown={handleKeyDown}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-default-200/60">
              <div className="flex items-center gap-2 text-sm">
                {selectedCompany && (
                  <span className="bg-accent/15 text-accent px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide">
                    {selectedCompany.name.slice(0, 3).toUpperCase()}
                  </span>
                )}
                <span className="text-foreground/30">/</span>
                <span className="text-foreground/60 font-medium">{newGoalDefaults.parentId ? "New sub-goal" : "New goal"}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  isIconOnly
                  size="sm"
                  className="text-foreground/40"
                  onPress={() => setExpanded(!expanded)}
                >
                  {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  isIconOnly
                  size="sm"
                  className="text-foreground/40"
                  onPress={() => { reset(); closeNewGoal(); }}
                >
                  <span className="text-lg leading-none">&times;</span>
                </Button>
              </div>
            </div>

            {/* Title */}
            <div className="px-4 pt-4 pb-2 shrink-0">
              <input
                className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-foreground/25"
                placeholder="Goal title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Tab" && !e.shiftKey) {
                    e.preventDefault();
                    descriptionEditorRef.current?.focus();
                  }
                }}
                autoFocus
              />
            </div>

            {/* Description */}
            <div className="px-4 pb-2">
              <MarkdownEditor
                ref={descriptionEditorRef}
                value={description}
                onChange={setDescription}
                placeholder="Add description..."
                bordered={false}
                contentClassName={cn("text-sm text-foreground/40", expanded ? "min-h-[220px]" : "min-h-[120px]")}
                imageUploadHandler={async (file) => {
                  const asset = await uploadDescriptionImage.mutateAsync(file);
                  return asset.contentPath;
                }}
              />
            </div>

            {/* Property chips */}
            <div className="flex items-center gap-1.5 px-4 py-2 border-t border-default-200/40 flex-wrap">
              {/* Status */}
              <Popover isOpen={statusOpen} onOpenChange={setStatusOpen}>
                <Popover.Trigger>
                  <button className="inline-flex items-center gap-1.5 rounded-md border border-default-200/40 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors">
                    <StatusBadge status={status} />
                  </button>
                </Popover.Trigger>
                <Popover.Content className="w-40 p-0">
                  <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg p-1.5">
                    {GOAL_STATUSES.map((s) => (
                      <button
                        key={s}
                        className={cn(
                          "flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg text-foreground hover:bg-default/40 capitalize",
                          s === status && "bg-accent/[0.08] text-accent font-medium"
                        )}
                        onClick={() => { setStatus(s); setStatusOpen(false); }}
                      >
                        {s}
                      </button>
                    ))}
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>

              {/* Level */}
              <Popover isOpen={levelOpen} onOpenChange={setLevelOpen}>
                <Popover.Trigger>
                  <button className="inline-flex items-center gap-1.5 rounded-md border border-default-200/40 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors">
                    <Layers className="h-3 w-3 text-foreground/40" />
                    {levelLabels[level] ?? level}
                  </button>
                </Popover.Trigger>
                <Popover.Content className="w-40 p-0">
                  <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg p-1.5">
                    {GOAL_LEVELS.map((l) => (
                      <button
                        key={l}
                        className={cn(
                          "flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg text-foreground hover:bg-default/40",
                          l === level && "bg-accent/[0.08] text-accent font-medium"
                        )}
                        onClick={() => { setLevel(l); setLevelOpen(false); }}
                      >
                        {levelLabels[l] ?? l}
                      </button>
                    ))}
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>

              {/* Parent goal */}
              <Popover isOpen={parentOpen} onOpenChange={setParentOpen}>
                <Popover.Trigger>
                  <button className="inline-flex items-center gap-1.5 rounded-md border border-default-200/40 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors">
                    <Target className="h-3 w-3 text-foreground/40" />
                    {currentParent ? currentParent.title : "Parent goal"}
                  </button>
                </Popover.Trigger>
                <Popover.Content className="w-48 p-0">
                  <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg p-1.5 max-h-56 overflow-y-auto">
                    <button
                      className={cn(
                        "flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg text-foreground hover:bg-default/40",
                        !appliedParentId && "bg-accent/[0.08] text-accent font-medium"
                      )}
                      onClick={() => { setParentId(""); setParentOpen(false); }}
                    >
                      No parent
                    </button>
                    {(goals ?? []).map((g) => (
                      <button
                        key={g.id}
                        className={cn(
                          "flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg text-foreground hover:bg-default/40 truncate",
                          g.id === appliedParentId && "bg-accent/[0.08] text-accent font-medium"
                        )}
                        onClick={() => { setParentId(g.id); setParentOpen(false); }}
                      >
                        {g.title}
                      </button>
                    ))}
                  </Popover.Dialog>
                </Popover.Content>
              </Popover>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end px-4 py-2.5 border-t border-default-200/40">
              <Button
                size="sm"
                variant="primary"
                isDisabled={!title.trim() || createGoal.isPending}
                onPress={handleSubmit}
              >
                {createGoal.isPending ? "Creating…" : newGoalDefaults.parentId ? "Create sub-goal" : "Create goal"}
              </Button>
            </div>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
