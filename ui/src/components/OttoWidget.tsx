/**
 * NUC-116: Otto Copilot widget
 *
 * Mounts the Chainlit Copilot floating chat bubble into the Paperclip layout.
 * Enabled when VITE_CHAINLIT_URL is set.
 *
 * Auth flow:
 *  1. Fetch a short-lived JWT from /api/copilot-token (requires board session).
 *  2. Pass as accessToken to mountChainlitWidget().
 *  3. Chainlit server validates the JWT via @cl.header_auth_callback.
 */

import { useEffect, useRef } from "react";

const CHAINLIT_URL = (import.meta.env.VITE_CHAINLIT_URL as string | undefined)?.replace(/\/$/, "");

declare global {
  interface Window {
    mountChainlitWidget?: (opts: {
      chainlitServer: string;
      theme?: "light" | "dark";
      accessToken?: string;
    }) => void;
    sendChainlitMessage?: (msg: { type: string; output: string }) => void;
  }
}

async function fetchCopilotToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/copilot-token");
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string | null };
    return data.token ?? null;
  } catch {
    return null;
  }
}

export function OttoWidget() {
  const mounted = useRef(false);

  useEffect(() => {
    if (!CHAINLIT_URL || mounted.current) return;

    let scriptEl: HTMLScriptElement | null = null;

    async function mount() {
      const token = await fetchCopilotToken();

      scriptEl = document.createElement("script");
      scriptEl.src = `${CHAINLIT_URL}/copilot/index.js`;
      scriptEl.async = true;

      scriptEl.onload = () => {
        window.mountChainlitWidget?.({
          chainlitServer: CHAINLIT_URL!,
          theme: "dark",
          ...(token ? { accessToken: `Bearer ${token}` } : {}),
        });
        mounted.current = true;
      };

      document.head.appendChild(scriptEl);
    }

    mount();

    return () => {
      if (scriptEl && document.head.contains(scriptEl)) {
        document.head.removeChild(scriptEl);
      }
    };
  }, []); // Mount once on load

  return null;
}
