import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Headphones, Play, Pause, Square, Loader2, FileText, ChevronDown, ChevronRight } from "lucide-react";
import { digestsApi, type DigestEntry } from "../api/digests";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function estimateWords(bytes: number): number {
  // Rough: avg ~5 chars/word, assume utf8 ~1 byte/char for English markdown
  return Math.round(bytes / 5);
}

export function DigestPlayerPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [selected, setSelected] = useState<DigestEntry | null>(null);
  const [script, setScript] = useState<string>("");
  const [highlightedWord, setHighlightedWord] = useState<number>(-1);
  const [playState, setPlayState] = useState<"idle" | "playing" | "paused">("idle");
  const [speed, setSpeed] = useState<number>(1);
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const wordsRef = useRef<string[]>([]);
  // Refs for stale-closure-safe access inside onend handler
  const autoAdvanceRef = useRef(autoAdvance);
  const topicsRef = useRef<string[]>([]);
  const groupedRef = useRef<Record<string, DigestEntry[]>>({});
  const selectedRef = useRef<DigestEntry | null>(null);
  const startPlaybackRef = useRef<() => void>(() => {});
  const shouldAutoGenerateRef = useRef(false);
  const autoPlayPendingRef = useRef(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Digest Player" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    function loadVoices() {
      const all = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
      setVoices(all);
      if (all.length > 0 && !voice) setVoice(all[0]!);
    }
    loadVoices();
    speechSynthesis.addEventListener("voiceschanged", loadVoices);
    return () => speechSynthesis.removeEventListener("voiceschanged", loadVoices);
  }, [voice]);

  const { data: digestsData } = useQuery({
    queryKey: queryKeys.digests.list(selectedCompanyId ?? ""),
    queryFn: () => digestsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const grouped = digestsData?.digests ?? {};
  const topics = Object.keys(grouped).sort();

  // Keep refs current so closures always see fresh values
  autoAdvanceRef.current = autoAdvance;
  topicsRef.current = topics;
  groupedRef.current = grouped;
  selectedRef.current = selected;

  // Auto-select today's most recent on first load
  useEffect(() => {
    if (selected || topics.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    for (const topic of topics) {
      const entries = grouped[topic] ?? [];
      const todayEntry = entries.find((e) => e.date === today);
      if (todayEntry) { setSelected(todayEntry); return; }
    }
    // fallback: first entry of first topic
    const firstTopic = topics[0];
    if (firstTopic && grouped[firstTopic]?.[0]) setSelected(grouped[firstTopic]![0]!);
  }, [topics.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: contentData, isLoading: contentLoading } = useQuery({
    queryKey: queryKeys.digests.content(selectedCompanyId ?? "", selected?.filename ?? ""),
    queryFn: () => digestsApi.getContent(selectedCompanyId!, selected!.filename),
    enabled: !!selectedCompanyId && !!selected,
  });

  const scriptMutation = useMutation({
    mutationFn: (content: string) => digestsApi.generatePodcastScript(selectedCompanyId!, content),
    onSuccess: (data) => {
      setScript(data.script);
      wordsRef.current = data.script.split(/\s+/);
      setHighlightedWord(-1);
      setPlayState("idle");
    },
  });

  const stopPlayback = useCallback(() => {
    speechSynthesis.cancel();
    setPlayState("idle");
    setHighlightedWord(-1);
  }, []);

  const startPlayback = useCallback(() => {
    if (!script) return;
    speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(script);
    utt.rate = speed;
    if (voice) utt.voice = voice;
    utt.onboundary = (e) => {
      if (e.name === "word") {
        const wordIndex = script.slice(0, e.charIndex).split(/\s+/).length - 1;
        setHighlightedWord(wordIndex);
      }
    };
    utt.onend = () => {
      setPlayState("idle");
      setHighlightedWord(-1);
      if (autoAdvanceRef.current) {
        const cur = selectedRef.current;
        const currentTopics = topicsRef.current;
        const currentGrouped = groupedRef.current;
        if (!cur) return;
        const topicIdx = currentTopics.indexOf(cur.topic);
        const entries = currentGrouped[cur.topic] ?? [];
        const entryIdx = entries.findIndex((e) => e.filename === cur.filename);
        let next: DigestEntry | null = null;
        if (entryIdx < entries.length - 1) {
          next = entries[entryIdx + 1] ?? null;
        } else if (topicIdx < currentTopics.length - 1) {
          const nextTopic = currentTopics[topicIdx + 1];
          next = (nextTopic && currentGrouped[nextTopic]?.[0]) || null;
        }
        if (next) {
          setSelected(next);
          setScript("");
          setHighlightedWord(-1);
          shouldAutoGenerateRef.current = true;
          autoPlayPendingRef.current = true;
        }
      }
    };
    utteranceRef.current = utt;
    speechSynthesis.speak(utt);
    setPlayState("playing");
  }, [script, speed, voice]);

  const pausePlayback = useCallback(() => {
    speechSynthesis.pause();
    setPlayState("paused");
  }, []);

  const resumePlayback = useCallback(() => {
    speechSynthesis.resume();
    setPlayState("playing");
  }, []);

  // Keep startPlaybackRef current so the auto-play effect always calls the latest version
  useEffect(() => { startPlaybackRef.current = startPlayback; }, [startPlayback]);

  // After auto-advance selects a new entry, auto-generate its script once content loads
  useEffect(() => {
    if (shouldAutoGenerateRef.current && contentData) {
      shouldAutoGenerateRef.current = false;
      scriptMutation.mutate(contentData.content);
    }
  }, [contentData]); // eslint-disable-line react-hooks/exhaustive-deps

  // After auto-generate produces a script, start playback
  useEffect(() => {
    if (autoPlayPendingRef.current && script) {
      autoPlayPendingRef.current = false;
      startPlaybackRef.current();
    }
  }, [script]);

  const words = wordsRef.current;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel — digest list */}
      <div className="w-72 flex-shrink-0 border-r border-neutral-200 overflow-y-auto p-3">
        <div className="flex items-center gap-2 mb-4 px-1">
          <Headphones className="h-4 w-4 text-neutral-500" />
          <span className="text-sm font-semibold text-neutral-700">Digests</span>
        </div>
        {topics.length === 0 && (
          <p className="text-xs text-neutral-400 px-1">No digest files found.</p>
        )}
        {topics.map((topic) => {
          const entries = grouped[topic] ?? [];
          const isOpen = !collapsed[topic];
          return (
            <div key={topic} className="mb-2">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [topic]: !c[topic] }))}
                className="flex items-center gap-1 w-full text-left px-1 py-1 text-xs font-medium text-neutral-500 uppercase tracking-wide hover:text-neutral-700"
              >
                {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {topic.replace(/-/g, " ")}
              </button>
              {isOpen && entries.map((entry) => (
                <button
                  key={entry.filename}
                  onClick={() => { setSelected(entry); setScript(""); setPlayState("idle"); setHighlightedWord(-1); }}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded text-xs hover:bg-neutral-100 flex flex-col gap-0.5",
                    selected?.filename === entry.filename && "bg-blue-50 text-blue-700",
                  )}
                >
                  <span className="font-medium">{entry.date}</span>
                  <span className="text-neutral-400">~{estimateWords(entry.size).toLocaleString()} words</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {/* Right panel — player */}
      <div className="flex-1 flex flex-col overflow-hidden p-6">
        {!selected ? (
          <div className="flex flex-col items-center justify-center h-full text-neutral-400 gap-3">
            <Headphones className="h-12 w-12 opacity-30" />
            <p className="text-sm">Select a digest to get started</p>
          </div>
        ) : (
          <>
            <div className="mb-4">
              <h1 className="text-lg font-semibold text-neutral-800 capitalize">
                {selected.topic.replace(/-/g, " ")}
              </h1>
              <p className="text-sm text-neutral-500">{selected.date} · {formatBytes(selected.size)}</p>
            </div>

            {/* Generate script button */}
            {!script && (
              <div className="mb-4">
                <Button
                  onClick={() => contentData && scriptMutation.mutate(contentData.content)}
                  disabled={!contentData || scriptMutation.isPending || contentLoading}
                  className="gap-2"
                >
                  {scriptMutation.isPending ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Generating…</>
                  ) : contentLoading ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Loading digest…</>
                  ) : (
                    <><FileText className="h-4 w-4" /> Generate Podcast Script</>
                  )}
                </Button>
              </div>
            )}

            {/* Script display with word highlight */}
            {script && (
              <>
                <div className="flex-1 overflow-y-auto rounded border border-neutral-200 bg-neutral-50 p-4 mb-4 text-sm leading-relaxed">
                  {words.map((word, i) => (
                    <span
                      key={i}
                      className={cn(
                        "transition-colors",
                        i === highlightedWord && "bg-yellow-200 rounded px-0.5",
                      )}
                    >
                      {word}{" "}
                    </span>
                  ))}
                </div>

                {/* Controls */}
                <div className="flex flex-wrap items-center gap-3">
                  {/* Play / Pause / Stop */}
                  <div className="flex items-center gap-1">
                    {playState === "playing" ? (
                      <Button size="sm" variant="outline" onClick={pausePlayback} className="gap-1">
                        <Pause className="h-4 w-4" /> Pause
                      </Button>
                    ) : playState === "paused" ? (
                      <Button size="sm" onClick={resumePlayback} className="gap-1">
                        <Play className="h-4 w-4" /> Resume
                      </Button>
                    ) : (
                      <Button size="sm" onClick={startPlayback} className="gap-1">
                        <Play className="h-4 w-4" /> Play
                      </Button>
                    )}
                    {playState !== "idle" && (
                      <Button size="sm" variant="outline" onClick={stopPlayback} className="gap-1">
                        <Square className="h-4 w-4" /> Stop
                      </Button>
                    )}
                  </div>

                  {/* Speed */}
                  <div className="flex items-center gap-1 text-xs text-neutral-500">
                    <span>Speed:</span>
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        onClick={() => { setSpeed(s); if (playState === "playing") { stopPlayback(); setTimeout(startPlayback, 100); } }}
                        className={cn("px-2 py-0.5 rounded border text-xs", speed === s ? "bg-blue-600 text-white border-blue-600" : "border-neutral-300 hover:border-neutral-400")}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>

                  {/* Voice selector */}
                  {voices.length > 0 && (
                    <div className="flex items-center gap-1 text-xs text-neutral-500">
                      <span>Voice:</span>
                      <select
                        className="border border-neutral-300 rounded px-2 py-0.5 text-xs bg-white"
                        value={voice?.name ?? ""}
                        onChange={(e) => {
                          const v = voices.find((v) => v.name === e.target.value) ?? null;
                          setVoice(v);
                        }}
                      >
                        {voices.map((v) => (
                          <option key={v.name} value={v.name}>{v.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Auto-advance toggle */}
                  <label className="flex items-center gap-1 text-xs text-neutral-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoAdvance}
                      onChange={(e) => setAutoAdvance(e.target.checked)}
                      className="rounded"
                    />
                    Auto-advance
                  </label>

                  {/* Re-generate */}
                  <Button size="sm" variant="ghost" onClick={() => { setScript(""); stopPlayback(); }} className="text-xs ml-auto">
                    Regenerate
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
