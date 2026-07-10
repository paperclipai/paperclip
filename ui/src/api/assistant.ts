import { api } from "./client";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

// Streams the assistant reply over SSE. The shared api client (client.ts) is JSON-only,
// so this reads the response body directly. Resolves when the stream completes; rejects
// on transport or server-signalled error.
export async function streamAssistantChat(
  companyId: string,
  messages: AssistantMessage[],
  { onDelta, signal }: StreamCallbacks,
): Promise<void> {
  const res = await fetch(`/api/companies/${companyId}/assistant/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Assistant request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let settled = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        const evt = JSON.parse(payload) as { type: string; text?: string; error?: string };
        if (evt.type === "delta" && evt.text) onDelta(evt.text);
        else if (evt.type === "error") {
          settled = true;
          throw new Error(evt.error ?? "assistant stream error");
        } else if (evt.type === "done") {
          settled = true;
          return;
        }
      }
    }
    // The stream ended without a done/error frame — the reply was truncated
    // (proxy timeout, dropped connection, server crash). Surface it, don't
    // let the caller treat a partial answer as a clean completion.
    if (!settled) throw new Error("Assistant connection ended unexpectedly.");
  } finally {
    reader.releaseLock();
  }
}

export interface DigestResult {
  markdown: string;
  generatedAt: string;
}

export function generateDigest(companyId: string): Promise<DigestResult> {
  return api.post<DigestResult>(`/companies/${companyId}/assistant/digest`, {});
}
