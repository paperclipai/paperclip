import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { voiceApi, type VoiceCommand } from "../api/voice";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "../lib/utils";
import { Mic, MicOff, Send, ExternalLink, CornerDownLeft, Loader2, CheckCircle2, XCircle, Clock, AlertCircle, Trash2 } from "lucide-react";

// ─── Speech recognition types ───
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

// ─── Status badge ───
function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { icon: typeof Clock; label: string; className: string }> = {
    pending: { icon: Clock, label: "Pending", className: "text-yellow-600 bg-yellow-50 border-yellow-200" },
    queued: { icon: Clock, label: "Queued", className: "text-yellow-600 bg-yellow-50 border-yellow-200" },
    processing: { icon: Loader2, label: "Processing", className: "text-blue-600 bg-blue-50 border-blue-200" },
    completed: { icon: CheckCircle2, label: "Completed", className: "text-green-600 bg-green-50 border-green-200" },
    corrected: { icon: AlertCircle, label: "Corrected", className: "text-orange-600 bg-orange-50 border-orange-200" },
    failed: { icon: XCircle, label: "Failed", className: "text-red-600 bg-red-50 border-red-200" },
  };
  const c = config[status] ?? config.pending;
  const Icon = c.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", c.className)}>
      <Icon className={cn("h-3 w-3", status === "processing" && "animate-spin")} />
      {c.label}
    </span>
  );
}

// ─── Audit trail row ───
function VoiceCommandRow({
  cmd,
  companyPrefix,
  onCorrect,
  onDelete,
}: {
  cmd: VoiceCommand;
  companyPrefix: string;
  onCorrect: (cmd: VoiceCommand) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isActive = cmd.status === "processing" || cmd.status === "queued";

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm truncate">{cmd.rawText}</p>
            {cmd.actionTaken && (
              <p className={cn(
                "text-xs mt-0.5 truncate",
                isActive ? "text-blue-600" : "text-muted-foreground"
              )}>
                {isActive && <Loader2 className="h-3 w-3 inline mr-1 animate-spin" />}
                {cmd.actionTaken}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={cmd.status} />
            <span className="text-xs text-muted-foreground">
              {new Date(cmd.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <div className="rounded-md bg-muted/30 p-3 text-sm">
            <p className="font-medium text-xs text-muted-foreground mb-1">Full input:</p>
            <p>{cmd.rawText}</p>
          </div>

          {cmd.classification && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Classification:</span>
              <span className="font-medium">{cmd.classification}</span>
            </div>
          )}

          {cmd.createdIssueId && (
            <a
              href={`/${companyPrefix}/issues/${cmd.createdIssueId}`}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              View Issue
            </a>
          )}

          {cmd.correctionHistory && cmd.correctionHistory.length > 0 && (
            <div className="border-t border-border pt-2 mt-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">Corrections:</p>
              {cmd.correctionHistory.map((c, i) => (
                <div key={i} className="text-xs text-muted-foreground ml-2">
                  <span className="font-medium">{c.action}:</span> {c.correctionText}
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onCorrect(cmd);
              }}
            >
              <CornerDownLeft className="h-3 w-3 mr-1" />
              Correct
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(cmd.id);
              }}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Voice Page ───
export function Voice() {
  const { selectedCompanyId } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [inputText, setInputText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [correcting, setCorrecting] = useState<VoiceCommand | null>(null);
  const [correctionText, setCorrectionText] = useState("");
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Find the router agent
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const routerAgent = agents?.find((a) => a.urlKey === "router" || a.name === "Router");

  // Voice commands list
  const { data: commands = [], isLoading } = useQuery({
    queryKey: queryKeys.voice.list(selectedCompanyId ?? ""),
    queryFn: () => voiceApi.list(selectedCompanyId!, { limit: 50 }),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  // Create voice command mutation
  const createMutation = useMutation({
    mutationFn: (rawText: string) =>
      voiceApi.create(selectedCompanyId!, {
        rawText,
        routerAgentId: routerAgent?.id,
      }),
    onSuccess: () => {
      setInputText("");
      queryClient.invalidateQueries({ queryKey: queryKeys.voice.list(selectedCompanyId!) });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => voiceApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.voice.list(selectedCompanyId!) });
    },
  });

  // Correction mutation
  const correctMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      voiceApi.correct(id, {
        correctionText: text,
        action: "updated",
      }),
    onSuccess: () => {
      setCorrecting(null);
      setCorrectionText("");
      queryClient.invalidateQueries({ queryKey: queryKeys.voice.list(selectedCompanyId!) });
    },
  });

  // Set breadcrumbs
  useEffect(() => {
    setBreadcrumbs([{ label: "Voice" }]);
  }, [setBreadcrumbs]);

  // Speech recognition setup
  const hasSpeechRecognition = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) return;

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInputText(transcript);
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening]);

  const handleSubmit = () => {
    const text = inputText.trim();
    if (!text || createMutation.isPending) return;
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    }
    createMutation.mutate(text);
  };

  const handleCorrection = () => {
    if (!correcting || !correctionText.trim()) return;
    correctMutation.mutate({ id: correcting.id, text: correctionText.trim() });
  };

  if (!selectedCompanyId) {
    return <div className="p-6 text-muted-foreground">Select a company to use Voice Commander.</div>;
  }

  return (
    <div className="flex flex-col h-full max-w-2xl mx-auto p-4 md:p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Voice Commander</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Speak or type a command. The router will classify it and take action.
        </p>
        {routerAgent && (
          <p className="text-xs text-muted-foreground mt-1">
            Router: <span className="font-medium">{routerAgent.name}</span>
          </p>
        )}
        {!routerAgent && agents && (
          <p className="text-xs text-yellow-600 mt-1">
            No router agent found. Create an agent named "Router" to enable automatic routing.
          </p>
        )}
      </div>

      {/* Voice Input */}
      <div className="rounded-lg border border-border bg-card p-4 mb-6">
        <div className="flex gap-2">
          <Textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={isListening ? "Listening..." : "Type or speak a command..."}
            className={cn(
              "min-h-[80px] resize-none flex-1",
              isListening && "border-red-400 ring-1 ring-red-400",
            )}
            disabled={createMutation.isPending}
          />
        </div>

        <div className="flex items-center justify-between mt-3">
          <div className="flex gap-2">
            {hasSpeechRecognition && (
              <Button
                variant={isListening ? "destructive" : "outline"}
                size="sm"
                onClick={toggleListening}
                disabled={createMutation.isPending}
              >
                {isListening ? (
                  <>
                    <MicOff className="h-4 w-4 mr-1" />
                    Stop
                  </>
                ) : (
                  <>
                    <Mic className="h-4 w-4 mr-1" />
                    Record
                  </>
                )}
              </Button>
            )}
          </div>

          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!inputText.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-1" />
            )}
            Send
          </Button>
        </div>

        {createMutation.isError && (
          <p className="text-xs text-red-500 mt-2">
            Failed to send command. Try again.
          </p>
        )}
      </div>

      {/* Correction Panel */}
      {correcting && (
        <div className="rounded-lg border border-orange-200 bg-orange-50/50 p-4 mb-6">
          <div className="flex items-start justify-between mb-2">
            <div>
              <p className="text-sm font-medium">Correcting command:</p>
              <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-md">{correcting.rawText}</p>
              {correcting.actionTaken && (
                <p className="text-xs text-muted-foreground">Action: {correcting.actionTaken}</p>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setCorrecting(null)}>
              <XCircle className="h-4 w-4" />
            </Button>
          </div>
          <Textarea
            value={correctionText}
            onChange={(e) => setCorrectionText(e.target.value)}
            placeholder="What should have happened instead?"
            className="min-h-[60px] resize-none mb-2"
          />
          <Button
            size="sm"
            onClick={handleCorrection}
            disabled={!correctionText.trim() || correctMutation.isPending}
          >
            {correctMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <CornerDownLeft className="h-4 w-4 mr-1" />
            )}
            Submit Correction
          </Button>
        </div>
      )}

      {/* Audit Trail */}
      <div className="flex-1 min-h-0">
        <h2 className="text-sm font-medium text-muted-foreground mb-2">Command History</h2>
        <div className="rounded-lg border border-border bg-card overflow-y-auto max-h-[calc(100vh-480px)]">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : commands.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Mic className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">No commands yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Use the input above to send your first voice command.
              </p>
            </div>
          ) : (
            commands.map((cmd) => (
              <VoiceCommandRow
                key={cmd.id}
                cmd={cmd}
                companyPrefix={companyPrefix ?? ""}
                onCorrect={(c) => {
                  setCorrecting(c);
                  setCorrectionText("");
                }}
                onDelete={(id) => deleteMutation.mutate(id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
