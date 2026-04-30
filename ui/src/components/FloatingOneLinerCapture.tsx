import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Mic, MicOff, Send, Sparkles, SquarePen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/lib/router";
import { projectsApi } from "../api/projects";
import { rt2TasksApi, type Rt2InboundDraftResponse } from "../api/rt2-tasks";
import { useCompany } from "../context/CompanyContext";
import {
  parseOneLinerInput,
  type OneLinerDraft,
} from "../lib/one-liner-draft";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

const PROJECT_STORAGE_KEY = "paperclip.rt2.one-liner.project";

type SpeechRecognitionResultEvent = Event & {
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
      };
    };
  };
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const record = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return record.SpeechRecognition ?? record.webkitSpeechRecognition ?? null;
}

function emptyDraft(rawInput: string): OneLinerDraft {
  return {
    rawInput,
    taskTitle: "",
    todoTitle: "",
    dailyLog: "",
    deliverableTitle: "",
    basePrice: null,
    taskMode: "solo",
    capacity: 1,
    warnings: [],
  };
}

function buildReviewedOneLinerText(draft: OneLinerDraft) {
  return [
    `task: ${draft.taskTitle.trim()}`,
    draft.todoTitle.trim() ? `todo: ${draft.todoTitle.trim()}` : null,
    `deliverable: ${draft.deliverableTitle.trim()}`,
    `price: ${draft.basePrice ?? 0}`,
    `mode: ${draft.taskMode}`,
    `capacity: ${draft.capacity}`,
    draft.dailyLog.trim() ? `daily: ${draft.dailyLog.trim()}` : null,
  ].filter(Boolean).join("; ");
}

export function FloatingOneLinerCapture({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const [projectId, setProjectId] = useState("");
  const [rawInput, setRawInput] = useState("");
  const [draft, setDraft] = useState<OneLinerDraft | null>(null);
  const [draftGenerated, setDraftGenerated] = useState(false);
  const [createdDraft, setCreatedDraft] = useState<Rt2InboundDraftResponse | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "listening" | "unsupported" | "error">("idle");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? ""),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && open),
  });

  const activeProjects = useMemo(() => projects.filter((project) => !project.archivedAt), [projects]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!selectedCompanyId || activeProjects.length === 0) return;
    const storedProjectId = window.localStorage.getItem(`${PROJECT_STORAGE_KEY}:${selectedCompanyId}`);
    if (storedProjectId && activeProjects.some((project) => project.id === storedProjectId)) {
      setProjectId(storedProjectId);
      return;
    }
    if (!projectId) {
      setProjectId(activeProjects[0]!.id);
    }
  }, [activeProjects, projectId, selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId || !projectId) return;
    window.localStorage.setItem(`${PROJECT_STORAGE_KEY}:${selectedCompanyId}`, projectId);
  }, [projectId, selectedCompanyId]);

  const createDraft = useMutation({
    mutationFn: async (reviewedDraft: OneLinerDraft) => {
      if (!selectedCompanyId) {
        throw new Error("회사 연결이 필요합니다.");
      }
      return rt2TasksApi.createInboundDraft(selectedCompanyId, {
        source: voiceState === "listening" ? "voice" : "floating",
        channel: projectId ? `daily-work:${projectId}` : "daily-work",
        text: buildReviewedOneLinerText(reviewedDraft),
      });
    },
    onSuccess: (result) => {
      if (!selectedCompanyId) return;
      setCreatedDraft(result);
      queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.captureQueue(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.rt2Tasks.listByProject(selectedCompanyId, projectId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(selectedCompanyId, projectId) });
      }
    },
  });

  if (!selectedCompany || !selectedCompanyId) return null;

  const draftWarnings = draftGenerated ? (draft?.warnings ?? []) : [];
  const draftReady = Boolean(
    projectId &&
      draft?.taskTitle.trim() &&
      draft?.deliverableTitle.trim() &&
      typeof draft?.basePrice === "number" &&
      draft.basePrice >= 0,
  );

  function updateRawInput(value: string) {
    setRawInput(value);
    setCreatedDraft(null);
    if (draftGenerated) {
      setDraft(emptyDraft(value));
    }
  }

  function generateDraft(value = rawInput) {
    setDraft(parseOneLinerInput(value));
    setDraftGenerated(true);
    setCreatedDraft(null);
  }

  function toggleVoice() {
    if (voiceState === "listening") {
      recognitionRef.current?.stop();
      setVoiceState("idle");
      return;
    }

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceState("unsupported");
      return;
    }

    const recognition = new Ctor();
    recognition.lang = "ko-KR";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = Array.from({ length: event.results.length })
        .map((_, index) => event.results[index]?.[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (!transcript) return;
      const nextInput = rawInput.trim() ? `${rawInput.trim()}\n${transcript}` : transcript;
      setRawInput(nextInput);
      generateDraft(nextInput);
    };
    recognition.onerror = () => setVoiceState("error");
    recognition.onend = () => setVoiceState((current) => (current === "listening" ? "idle" : current));
    recognitionRef.current = recognition;
    setVoiceState("listening");
    recognition.start();
  }

  return (
    <>
      <Button
        type="button"
        className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-[70] h-12 rounded-full px-4 shadow-lg md:bottom-5 md:right-5"
        onClick={() => onOpenChange(!open)}
          aria-label="빠른 업무 기록"
        >
          <SquarePen className="mr-2 h-4 w-4" />
          업무 기록
      </Button>

      {open ? (
        <div className="fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-[75] rounded-lg border border-border bg-card shadow-2xl md:inset-x-auto md:bottom-20 md:right-5 md:w-[30rem]">
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <div className="text-sm font-semibold">빠른 업무 기록</div>
              <div className="text-xs text-muted-foreground">현재 화면을 유지한 채 작업 신호를 남깁니다.</div>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="max-h-[70dvh] space-y-3 overflow-auto p-4">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>프로젝트</span>
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">프로젝트 선택</option>
                {activeProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <textarea
              ref={textareaRef}
              value={rawInput}
              onChange={(event) => updateRawInput(event.target.value)}
              placeholder="task: 고객 제안서 정리; deliverable: 제안서 초안; price: 180000"
              className="min-h-28 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" disabled={!rawInput.trim() || !projectId} onClick={() => generateDraft()}>
                <Sparkles className="mr-2 h-4 w-4" />
                초안
              </Button>
              <Button
                type="button"
                size="sm"
                variant={voiceState === "listening" ? "destructive" : "outline"}
                onClick={toggleVoice}
              >
                {voiceState === "listening" ? <MicOff className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
                {voiceState === "listening" ? "중지" : "음성"}
              </Button>
              <span className={cn("text-xs text-muted-foreground", voiceState === "error" && "text-destructive")}>
                {voiceState === "unsupported"
                  ? "이 브라우저는 음성 인식을 지원하지 않습니다."
                  : voiceState === "error"
                    ? "음성 입력을 시작하지 못했습니다."
                    : "빠른 기록 단축키 c"}
              </span>
            </div>

            {draftGenerated && draft ? (
              <div className="space-y-3 rounded-md border border-border bg-background p-3">
                {draftWarnings.length > 0 ? (
                  <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100">
                    {draftWarnings.join(" ")}
                  </div>
                ) : null}

                <input
                  aria-label="Floating task title"
                  value={draft.taskTitle}
                  onChange={(event) => setDraft({ ...draft, taskTitle: event.target.value })}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none"
                  placeholder="업무 제목"
                />
                <input
                  aria-label="Floating deliverable title"
                  value={draft.deliverableTitle}
                  onChange={(event) => setDraft({ ...draft, deliverableTitle: event.target.value })}
                  className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none"
                  placeholder="산출물"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    aria-label="Floating base price"
                    type="number"
                    min={0}
                    value={draft.basePrice ?? ""}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        basePrice: event.target.value === "" ? null : Number.parseInt(event.target.value, 10),
                      })
                    }
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none"
                    placeholder="기준가"
                  />
                  <select
                    value={draft.taskMode}
                    onChange={(event) => setDraft({ ...draft, taskMode: event.target.value as "solo" | "collab" })}
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground outline-none"
                  >
                    <option value="solo">개인</option>
                    <option value="collab">협업</option>
                  </select>
                </div>

                <Button
                  type="button"
                  className="w-full"
                  disabled={!draftReady || createDraft.isPending}
                  onClick={() => createDraft.mutate(draft)}
                >
                  <Send className="mr-2 h-4 w-4" />
                  {createDraft.isPending ? "검수함에 보내는 중..." : "보드 검수함에 보내기"}
                </Button>
              </div>
            ) : null}

            {createdDraft ? (
              <div className="rounded-md border border-emerald-300/70 bg-emerald-50 px-3 py-3 text-sm text-emerald-950 dark:border-emerald-800/70 dark:bg-emerald-950/30 dark:text-emerald-100">
                <div className="font-medium">보드 검수함에 초안을 보냈습니다</div>
                <div className="mt-1 text-xs">
                  {createdDraft.draft.taskTitle} · {createdDraft.inbound.status === "duplicate" ? "중복 의심" : "검수 필요"}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3 bg-background/80"
                  onClick={() => navigate("/daily-work")}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  일일 업무 보드에서 검수
                </Button>
              </div>
            ) : null}

            {createDraft.isError ? (
              <p className="text-sm text-destructive">
                {createDraft.error instanceof Error ? createDraft.error.message : "업무 초안 등록에 실패했습니다."}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
