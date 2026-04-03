import { useState } from "react";
import {
  ArrowRight,
  Bot,
  Clock,
  Minus,
  PenLine,
  Plus,
  Wand2,
  Trash2,
} from "lucide-react";
import { api } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";

const CATEGORIES = [
  { value: "onboarding", label: "Onboarding" },
  { value: "security", label: "Security" },
  { value: "engineering", label: "Engineering" },
  { value: "operations", label: "Operations" },
  { value: "marketing", label: "Marketing" },
  { value: "custom", label: "Custom" },
];

interface StepDraft {
  title: string;
  instructions: string;
  assigneeRole: string;
  dependsOn: string;
  estimatedMinutes: string;
  requiresApproval: boolean;
}

function emptyStep(): StepDraft {
  return {
    title: "",
    instructions: "",
    assigneeRole: "",
    dependsOn: "",
    estimatedMinutes: "",
    requiresApproval: false,
  };
}

interface NewPlaybookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (playbook: {
    name: string;
    description: string;
    body: string;
    category: string;
    estimatedMinutes: number | undefined;
    steps: Array<{
      stepOrder: number;
      title: string;
      instructions: string;
      assigneeRole: string;
      dependsOn: number[];
      estimatedMinutes: number | undefined;
      requiresApproval: boolean;
    }>;
  }) => void;
  isPending?: boolean;
}

export function NewPlaybookDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: NewPlaybookDialogProps) {
  const [mode, setMode] = useState<"choose" | "manual" | "auto">("choose");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("custom");
  const [steps, setSteps] = useState<StepDraft[]>([emptyStep()]);

  const { selectedCompanyId } = useCompany();

  // Auto mode
  const [autoPrompt, setAutoPrompt] = useState("");
  const [autoGenerating, setAutoGenerating] = useState(false);

  function reset() {
    setMode("choose");
    setName("");
    setDescription("");
    setBody("");
    setCategory("custom");
    setSteps([emptyStep()]);
    setAutoPrompt("");
    setAutoGenerating(false);
  }

  function handleClose(isOpen: boolean) {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  }

  function addStep() {
    setSteps((prev) => [...prev, emptyStep()]);
  }

  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateStep(idx: number, field: keyof StepDraft, value: string | boolean) {
    setSteps((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)),
    );
  }

  function handleSubmit() {
    const parsed = steps
      .filter((s) => s.title.trim())
      .map((s, idx) => ({
        stepOrder: idx + 1,
        title: s.title.trim(),
        instructions: s.instructions.trim(),
        assigneeRole: s.assigneeRole.trim().toLowerCase(),
        dependsOn: s.dependsOn
          .split(",")
          .map((d) => parseInt(d.trim(), 10))
          .filter((n) => !isNaN(n)),
        estimatedMinutes: s.estimatedMinutes ? parseInt(s.estimatedMinutes, 10) || undefined : undefined,
        requiresApproval: s.requiresApproval,
      }));

    const totalMinutes = parsed.reduce((sum, s) => sum + (s.estimatedMinutes ?? 0), 0);

    onSubmit({
      name: name.trim(),
      description: description.trim(),
      body: body.trim(),
      category,
      estimatedMinutes: totalMinutes || undefined,
      steps: parsed,
    });
  }

  // ─── Mode chooser ────────────────────────────────────────────────
  if (mode === "choose") {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Playbook</DialogTitle>
            <DialogDescription>
              How would you like to create your playbook?
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3 py-4">
            <button
              onClick={() => setMode("manual")}
              className="flex flex-col items-center gap-3 p-6 rounded-lg border border-border hover:border-foreground/30 hover:bg-accent/50 transition-colors"
            >
              <PenLine className="h-8 w-8 text-muted-foreground" />
              <div className="text-center">
                <p className="text-sm font-medium">Manual</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Build step-by-step with a form
                </p>
              </div>
            </button>

            <button
              onClick={() => setMode("auto")}
              className="flex flex-col items-center gap-3 p-6 rounded-lg border border-border hover:border-foreground/30 hover:bg-accent/50 transition-colors relative"
            >
              <Bot className="h-8 w-8 text-muted-foreground" />
              <div className="text-center">
                <p className="text-sm font-medium">AI-Assisted</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Describe it, AI generates it
                </p>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── Auto mode ────────────────────────────────────────────────────
  if (mode === "auto") {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-blue-500" />
              AI-Assisted Playbook
            </DialogTitle>
            <DialogDescription>
              Describe what you want the playbook to accomplish. Be specific about the goal, which roles should be involved, and any constraints.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2">
            <Textarea
              value={autoPrompt}
              onChange={(e) => setAutoPrompt(e.target.value)}
              placeholder={`Example: "I need a playbook for launching a new SaaS feature. It should include product scoping by the CEO, technical design by the CTO, implementation by engineering, security review, QA, deployment, and a marketing announcement. The whole thing should take about a week."`}
              className="min-h-[160px] text-sm"
            />
            <p className="text-[11px] text-muted-foreground mt-2">
              The AI will generate a complete playbook with steps, role assignments, dependencies, and time estimates. You can edit everything after generation.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMode("choose")}>
              Back
            </Button>
            <Button
              onClick={async () => {
                if (!selectedCompanyId) return;
                setAutoGenerating(true);
                try {
                  const result = await api.post<{
                    name: string;
                    description: string;
                    body: string;
                    category: string;
                    steps: Array<{
                      stepOrder: number;
                      title: string;
                      instructions: string;
                      assigneeRole: string;
                      dependsOn: number[];
                      requiresApproval: boolean;
                    }>;
                  }>(
                    `/companies/${encodeURIComponent(selectedCompanyId)}/ai/generate-playbook`,
                    { prompt: autoPrompt },
                  );
                  // Populate the manual form with generated data
                  setName(result.name);
                  setDescription(result.description);
                  setBody(result.body);
                  setCategory(result.category);
                  setSteps(
                    result.steps.map((s) => ({
                      title: s.title,
                      instructions: s.instructions,
                      assigneeRole: s.assigneeRole,
                      dependsOn: s.dependsOn.join(", "),
                      estimatedMinutes: "",
                      requiresApproval: s.requiresApproval,
                    })),
                  );
                  setMode("manual");
                } catch {
                  // Fallback: just populate with prompt
                  setBody(autoPrompt);
                  setName("Generated Playbook");
                  setDescription("Edit to customize");
                  setMode("manual");
                } finally {
                  setAutoGenerating(false);
                }
              }}
              disabled={!autoPrompt.trim() || autoGenerating}
            >
              {autoGenerating ? (
                <>
                  <Wand2 className="h-3.5 w-3.5 mr-1.5 animate-pulse" />
                  Generating...
                </>
              ) : (
                <>
                  <Wand2 className="h-3.5 w-3.5 mr-1.5" />
                  Generate Playbook
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── Manual mode ──────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Playbook</DialogTitle>
          <DialogDescription>
            Define your multi-agent workflow step by step.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Basics */}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. New Client Onboarding"
                className="mt-1"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-liner explaining what this playbook does"
                className="mt-1"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat.value}
                    onClick={() => setCategory(cat.value)}
                    className={cn(
                      "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                      category === cat.value
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/30",
                    )}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-muted-foreground">Steps</label>
              <Button variant="ghost" size="xs" onClick={addStep}>
                <Plus className="h-3 w-3 mr-1" />
                Add Step
              </Button>
            </div>

            <div className="space-y-3">
              {steps.map((step, idx) => (
                <div
                  key={idx}
                  className="border border-border rounded-lg p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex items-center justify-center h-5 w-5 rounded-full bg-accent text-[11px] font-medium shrink-0">
                      {idx + 1}
                    </span>
                    <Input
                      value={step.title}
                      onChange={(e) => updateStep(idx, "title", e.target.value)}
                      placeholder="Step title"
                      className="h-7 text-xs flex-1"
                    />
                    {steps.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removeStep(idx)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  <Textarea
                    value={step.instructions}
                    onChange={(e) => updateStep(idx, "instructions", e.target.value)}
                    placeholder="Instructions for the agent executing this step..."
                    className="min-h-[60px] text-xs"
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-muted-foreground">Assignee Role</label>
                      <Input
                        value={step.assigneeRole}
                        onChange={(e) => updateStep(idx, "assigneeRole", e.target.value)}
                        placeholder="e.g. cto"
                        className="h-6 text-[11px] mt-0.5"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground">Depends on steps</label>
                      <Input
                        value={step.dependsOn}
                        onChange={(e) => updateStep(idx, "dependsOn", e.target.value)}
                        placeholder="e.g. 1, 2"
                        className="h-6 text-[11px] mt-0.5"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground">Est. minutes</label>
                      <Input
                        value={step.estimatedMinutes}
                        onChange={(e) => updateStep(idx, "estimatedMinutes", e.target.value)}
                        placeholder="30"
                        className="h-6 text-[11px] mt-0.5"
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={step.requiresApproval}
                      onChange={(e) => updateStep(idx, "requiresApproval", e.target.checked)}
                      className="rounded border-border"
                    />
                    Requires approval before completing
                  </label>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || steps.filter((s) => s.title.trim()).length === 0 || isPending}
          >
            {isPending ? "Creating..." : "Create Playbook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
