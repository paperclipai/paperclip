/**
 * Ollama model auto-pull + reachability helpers. Same shape as the aider-local
 * versions but slimmer — ollama_local doesn't need to bootstrap Python or
 * manage a venv, just talk to the Ollama HTTP API.
 */

export type OnLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaPullEvent {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

export async function listPulledOllamaModels(baseUrl: string): Promise<string[] | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as OllamaTagsResponse;
    return (body.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : null))
      .filter((s): s is string => s != null);
  } catch {
    return null;
  }
}

export async function probeOllamaReachable(baseUrl: string): Promise<{
  ok: boolean;
  detail?: string;
  models?: string[];
}> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, detail: `Ollama responded with HTTP ${res.status}` };
    const body = (await res.json()) as OllamaTagsResponse;
    const names = (body.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : null))
      .filter((s): s is string => s != null);
    return { ok: true, models: names };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "fetch failed" };
  }
}

/**
 * Ensure the configured Ollama model is pulled. Streams `POST /api/pull` events
 * to onLog when a pull is needed, throttled to status changes or 5%-step
 * progress updates so the run log stays readable.
 *
 * Throws if Ollama is unreachable so the caller can surface a single clear
 * error to the user (rather than letting the chat call later fail with the
 * same root cause).
 */
export async function ensureOllamaModelPulled(input: {
  model: string;
  baseUrl: string;
  onLog: OnLog;
}): Promise<void> {
  const reachable = await probeOllamaReachable(input.baseUrl);
  if (!reachable.ok) {
    throw new Error(
      `Cannot reach Ollama at ${input.baseUrl}: ${reachable.detail ?? "unknown error"}. ` +
        `Start Ollama with \`ollama serve\` and verify it is bound to that URL.`,
    );
  }
  const pulled = reachable.models ?? [];
  if (pulled.some((name) => name === input.model || name.startsWith(`${input.model}@`))) {
    return;
  }

  await input.onLog(
    "stdout",
    `[paperclip] Ollama model "${input.model}" is not pulled. Streaming "ollama pull ${input.model}" via the API…\n`,
  );

  const url = `${input.baseUrl.replace(/\/$/, "")}/api/pull`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: input.model, stream: true }),
  });
  if (!res.ok || !res.body) {
    throw new Error(
      `Ollama pull request for "${input.model}" failed: HTTP ${res.status} ${res.statusText}.`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastStatus = "";
  let lastPercent = -1;
  let sawError: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: OllamaPullEvent;
      try {
        event = JSON.parse(line) as OllamaPullEvent;
      } catch {
        continue;
      }
      if (event.error) {
        sawError = event.error;
        await input.onLog("stderr", `[paperclip ollama] error: ${event.error}\n`);
        continue;
      }
      const percent =
        event.total && event.completed != null
          ? Math.floor((event.completed / event.total) * 100)
          : null;
      if (
        event.status &&
        (event.status !== lastStatus || (percent != null && percent >= lastPercent + 5))
      ) {
        const pctText = percent != null ? ` ${percent}%` : "";
        await input.onLog("stdout", `[paperclip ollama] ${event.status}${pctText}\n`);
        lastStatus = event.status;
        if (percent != null) lastPercent = percent;
      }
    }
  }

  if (sawError) {
    throw new Error(`Ollama pull for "${input.model}" reported error: ${sawError}`);
  }

  await input.onLog("stdout", `[paperclip] Pulled ${input.model}.\n`);
}
