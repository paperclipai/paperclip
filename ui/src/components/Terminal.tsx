/**
 * Web terminal component backed by xterm.js.
 *
 * Connects to the server's PTY over WebSocket at /ws/terminal/:sessionId.
 * Creates a terminal session via POST /api/terminal/sessions.
 */

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  /** Working directory for the terminal session. */
  cwd: string;
  /** Called when the session is created. */
  onSessionCreated?: (sessionId: string) => void;
  /** Called when the terminal process exits. */
  onExit?: (code: number) => void;
  /** Additional CSS class for the container. */
  className?: string;
}

export function TerminalPanel({ cwd, onSessionCreated, onExit, className }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let term: XTerm | null = null;
    let ws: WebSocket | null = null;
    let observer: ResizeObserver | null = null;

    async function init() {
      // Create session
      setStatus("connecting");
      setError(null);

      let sid: string;
      try {
        const res = await fetch("/api/terminal/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
        });
        if (!res.ok) {
          const body = await res.text();
          if (!cancelled) {
            setError(`Session creation failed: ${body}`);
            setStatus("error");
          }
          return;
        }
        const data = await res.json() as { sessionId: string };
        sid = data.sessionId;
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
        return;
      }

      if (cancelled) return;

      setSessionId(sid);
      onSessionCreated?.(sid);

      // Initialize xterm
      term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
        lineHeight: 1.2,
        theme: {
          background: "hsl(0 0% 3.9%)",
          foreground: "hsl(0 0% 98%)",
          cursor: "hsl(0 0% 98%)",
          selectionBackground: "rgba(255, 255, 255, 0.15)",
          black: "#1a1a1a",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#f59e0b",
          blue: "#3b82f6",
          magenta: "#a855f7",
          cyan: "#06b6d4",
          white: "#e5e5e5",
          brightBlack: "#404040",
          brightRed: "#f87171",
          brightGreen: "#4ade80",
          brightYellow: "#fbbf24",
          brightBlue: "#60a5fa",
          brightMagenta: "#c084fc",
          brightCyan: "#22d3ee",
          brightWhite: "#fafafa",
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(container!);
      fitAddon.fit();

      // Connect WebSocket
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${sid}`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (cancelled) return;
        setStatus("connected");
        ws!.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
      };

      ws.onmessage = (event) => {
        if (cancelled || !term) return;
        const data = event.data as string;
        // Check for control messages
        if (data.startsWith("{")) {
          try {
            const msg = JSON.parse(data) as { type: string; code?: number; message?: string };
            if (msg.type === "exit") {
              setStatus("disconnected");
              onExit?.(msg.code ?? 0);
              return;
            }
            if (msg.type === "error") {
              setError(msg.message ?? "Unknown error");
              return;
            }
          } catch {
            // Not JSON control message — terminal output
          }
        }
        term.write(data);
      };

      ws.onclose = () => {
        if (!cancelled) setStatus("disconnected");
      };

      ws.onerror = () => {
        if (!cancelled) {
          setStatus("error");
          setError("WebSocket connection failed");
        }
      };

      // Terminal input → WebSocket
      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Handle resize
      term.onResize(({ cols, rows }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      // Resize observer
      observer = new ResizeObserver(() => {
        try { fitAddon.fit(); } catch { /* container may be gone */ }
      });
      observer.observe(container!);
    }

    void init();

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
      term?.dispose();
    };
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      {/* Status bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border bg-background">
        <span className={`inline-block w-2 h-2 rounded-full ${
          status === "connected" ? "bg-green-500" :
          status === "connecting" ? "bg-amber-500 animate-pulse" :
          status === "error" ? "bg-red-500" :
          "bg-gray-500"
        }`} />
        <span className="font-medium">
          {status === "connected" ? "Terminal" :
           status === "connecting" ? "Connecting..." :
           status === "error" ? "Error" :
           "Disconnected"}
        </span>
        <span className="opacity-50 truncate flex-1">{cwd}</span>
        {error && <span className="text-red-400 truncate">{error}</span>}
      </div>
      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ padding: "4px 0 0 4px" }}
      />
    </div>
  );
}
