import { useState, useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface TranscriptViewerProps {
  runId: string;
  initialStdout?: string;
  isLive?: boolean;
}

interface LogChunk {
  stream: string;
  chunk: string;
  ts: number;
}

export function TranscriptViewer({ runId, initialStdout, isLive = false }: TranscriptViewerProps) {
  const [chunks, setChunks] = useState<LogChunk[]>(() => {
    if (initialStdout) {
      return initialStdout.split("\n").filter(Boolean).map((line, i) => ({
        stream: "stdout", chunk: line + "\n", ts: i,
      }));
    }
    return [];
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  // Subscribe to live log events
  useEffect(() => {
    if (!isLive) return;

    let unlisten: UnlistenFn | undefined;
    listen<{ run_id: string; stream: string; chunk: string }>("agent-run-log", (event) => {
      if (event.payload.run_id === runId) {
        setChunks(prev => [...prev, {
          stream: event.payload.stream,
          chunk: event.payload.chunk,
          ts: Date.now(),
        }]);
      }
    }).then(fn => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, [runId, isLive]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chunks]);

  if (chunks.length === 0 && !isLive) {
    return (
      <div className="px-4 py-6 text-center text-[12px]" style={{ color: "var(--fg-muted)" }}>
        No transcript available.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="max-h-64 overflow-y-auto rounded-md border p-3"
      style={{ background: "var(--bg)", borderColor: "var(--border-subtle)", fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "1.6" }}
    >
      {chunks.length === 0 && isLive && (
        <div style={{ color: "var(--fg-muted)" }}>Waiting for output...</div>
      )}
      {chunks.map((chunk, i) => (
        <span key={i} style={{ color: chunk.stream === "stderr" ? "var(--destructive)" : "var(--fg-secondary)" }}>
          {chunk.chunk}
        </span>
      ))}
    </div>
  );
}
