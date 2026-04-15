import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { voiceApi, type VoiceCommandCreateResponse } from "../api/voice";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { cn } from "../lib/utils";
import { Loader2, CheckCircle2, XCircle, Zap } from "lucide-react";

export function CommandModal() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();

  const submit = useMutation({
    mutationFn: async (rawText: string) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return voiceApi.create(selectedCompanyId, { rawText });
    },
    onSuccess: (result: VoiceCommandCreateResponse) => {
      setText("");
      pushToast({
        title: "Command sent",
        body: result.actionTaken ?? result.classification ?? "Processing...",
        tone: "success",
      });
      // Close after brief delay so user sees the success
      setTimeout(() => setOpen(false), 600);
    },
    onError: (err: Error) => {
      pushToast({
        title: "Command failed",
        body: err.message,
        tone: "error",
      });
    },
  });

  // Ctrl+Shift+K → toggle
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setText("");
      submit.reset();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = text.trim();
      if (!trimmed || submit.isPending) return;
      submit.mutate(trimmed);
    },
    [text, submit],
  );

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />

      {/* Modal */}
      <div className="fixed left-1/2 top-1/3 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2">
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-muted/30">
            <Zap className="h-4 w-4 text-primary shrink-0" />
            <span className="text-sm font-medium">Command</span>
            <span className="ml-auto text-xs text-muted-foreground">Ctrl+Shift+K</span>
          </div>

          <div className="p-4">
            <input
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type a command... e.g. 'Create a task for CTO to review the API docs'"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              disabled={submit.isPending}
            />
          </div>

          <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/20">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {submit.isPending && (
                <>
                  <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                  <span>Processing...</span>
                </>
              )}
              {submit.isSuccess && (
                <>
                  <CheckCircle2 className="h-3 w-3 text-green-500" />
                  <span>Done</span>
                </>
              )}
              {submit.isError && (
                <>
                  <XCircle className="h-3 w-3 text-red-500" />
                  <span>Failed — try again</span>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded"
              >
                Esc
              </button>
              <button
                type="submit"
                disabled={!text.trim() || submit.isPending}
                className={cn(
                  "text-xs px-3 py-1 rounded-md font-medium transition-colors",
                  text.trim() && !submit.isPending
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-muted text-muted-foreground cursor-not-allowed",
                )}
              >
                Send
              </button>
            </div>
          </div>
        </form>
      </div>
    </>
  );
}
