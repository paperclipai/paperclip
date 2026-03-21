import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ArrowUp, Minus, ArrowDown } from "lucide-react";
import { useDialog } from "../context/DialogContext";
import { useToast } from "../context/ToastContext";
import { bugReportsApi, type BugReportPayload } from "../api/bug-reports";
import { cn } from "../lib/utils";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const severities = [
  { value: "critical", label: "Critical", icon: AlertTriangle, color: "text-red-500" },
  { value: "high", label: "High", icon: ArrowUp, color: "text-orange-500" },
  { value: "medium", label: "Medium", icon: Minus, color: "text-yellow-500" },
  { value: "low", label: "Low", icon: ArrowDown, color: "text-blue-500" },
] as const;

export function BugReportDialog() {
  const { bugReportOpen, closeBugReport } = useDialog();
  const { pushToast } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<BugReportPayload["severity"]>("medium");

  const submitBug = useMutation({
    mutationFn: (data: BugReportPayload) => bugReportsApi.submit(data),
  });

  function reset() {
    setTitle("");
    setDescription("");
    setSeverity("medium");
  }

  async function handleSubmit() {
    if (!title.trim()) return;
    try {
      const result = await submitBug.mutateAsync({
        title: title.trim(),
        description: description.trim(),
        severity,
        pageUrl: window.location.href,
        userAgent: navigator.userAgent,
      });
      reset();
      closeBugReport();
      pushToast({
        title: "Bug reported",
        body: result.issueIdentifier
          ? `Filed as ${result.issueIdentifier}`
          : "Submitted successfully",
        tone: "success",
      });
    } catch {
      // Error is surfaced via submitBug.isError
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <Dialog
      open={bugReportOpen}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          closeBugReport();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 sm:max-w-lg"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <span>Report a bug</span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => { reset(); closeBugReport(); }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        {/* Title */}
        <div className="px-4 pt-4 pb-2">
          <input
            className="w-full text-lg font-semibold bg-transparent outline-none placeholder:text-muted-foreground/50"
            placeholder="What went wrong?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="px-4 pb-3">
          <textarea
            className="w-full min-h-[120px] text-sm bg-transparent outline-none placeholder:text-muted-foreground/50 resize-y"
            placeholder="Steps to reproduce, what you expected, what happened instead..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Severity picker */}
        <div className="px-4 py-2 border-t border-border">
          <label className="text-xs text-muted-foreground mb-2 block">Severity</label>
          <div className="flex gap-1.5">
            {severities.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.value}
                  type="button"
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                    severity === s.value
                      ? "border-foreground bg-accent/40"
                      : "border-border hover:bg-accent/30"
                  )}
                  onClick={() => setSeverity(s.value)}
                >
                  <Icon className={cn("h-3 w-3", s.color)} />
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Context info */}
        <div className="px-4 py-2 border-t border-border">
          <p className="text-[11px] text-muted-foreground/60">
            Current page URL and browser info will be included automatically.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {submitBug.isError ? (
            <p className="text-xs text-destructive">Failed to submit. Check server configuration.</p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={!title.trim() || submitBug.isPending}
            onClick={handleSubmit}
          >
            {submitBug.isPending ? "Submitting..." : "Submit bug report"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
