# LM-Studio-Adapter Fallback-LLM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optionalen Fallback-Endpoint in den LM-Studio-Adapter einbauen, damit Paperclip-Agenten weiterlaufen, wenn der primäre LM-Studio-Host (z.B. Windows-PC) nicht erreichbar ist.

**Architecture:** Pro-Agent-Config bekommt `fallbackUrl`, `fallbackModel`, `probeTimeoutMs`. Der Adapter pingt den Primary am Heartbeat-Start, wechselt bei Fehler einmalig auf den Fallback, bleibt sticky bis Heartbeat-Ende, und postet ein Meta-Event beim Wechsel. Fehler werden typisiert (network/model/timeout), damit der Mid-Call-Fallback gezielt greift.

**Tech Stack:** TypeScript, Node 18+ fetch API, Vitest für Tests, OpenAI-kompatibler HTTP-Endpoint.

**Spec:** [docs/superpowers/specs/2026-04-20-lmstudio-fallback-design.md](../specs/2026-04-20-lmstudio-fallback-design.md)

---

## File Structure

| Datei | Zweck | Änderung |
|---|---|---|
| `paperclip-adapter-lmstudio/src/server/llm-client.ts` | OpenAI-kompatible HTTP-Calls | Typisierte Errors einführen, `probeEndpoint()` neu |
| `paperclip-adapter-lmstudio/src/server/execute.ts` | Heartbeat-Loop | Probe-Start, Sticky-State, Mid-Call-Switch, Meta-Event |
| `paperclip-adapter-lmstudio/src/server/index.ts` | ConfigSchema | Neue Felder (`fallbackUrl`, `fallbackModel`, `probeTimeoutMs`) |
| `paperclip-adapter-lmstudio/src/index.ts` | agentConfigurationDoc | Neue Felder dokumentieren |
| `paperclip-adapter-lmstudio/tests/fallback.test.ts` | Unit-Tests | Neu angelegt |
| `paperclip-adapter-lmstudio/README.md` | User-Doku | Fallback-Abschnitt |

---

## Task 1: Config-Schema um Fallback-Felder erweitern

**Files:**
- Modify: `paperclip-adapter-lmstudio/src/server/index.ts` (getConfigSchema, lines 42–109)
- Modify: `paperclip-adapter-lmstudio/src/index.ts` (agentConfigurationDoc, lines 5–14)

- [ ] **Step 1: Neue Config-Felder einfügen**

In `src/server/index.ts`, `getConfigSchema()`, Array `fields` direkt **nach** dem `defaultModel`-Feld (nach Zeile 66) einfügen:

```typescript
{
  key: "fallbackUrl",
  label: "Fallback LM Studio URL (optional)",
  type: "text" as const,
  hint: "Zweite LM-Studio-Instanz (z.B. Mac), die genutzt wird, wenn der Primary nicht erreichbar ist. Leer = kein Fallback.",
},
{
  key: "fallbackModel",
  label: "Fallback-Modell (optional)",
  type: "text" as const,
  hint: "Modellname auf dem Fallback-Host. Leer = gleicher Name wie Primary-Modell.",
},
{
  key: "probeTimeoutMs",
  label: "Health-Probe Timeout (ms)",
  type: "number" as const,
  default: 2000,
  hint: "Timeout für den kurzen Health-Check vor jedem Heartbeat. Bestimmt, wie schnell der Fallback greift, wenn der Primary-Host aus ist.",
},
```

- [ ] **Step 2: agentConfigurationDoc aktualisieren**

In `src/index.ts`, den Inhalt von `agentConfigurationDoc` ersetzen:

```typescript
export const agentConfigurationDoc = `# LM Studio Adapter Konfiguration

## Felder

- **url** (string): Primary LM-Studio-URL. Default: \`http://localhost:1234\`
- **defaultModel** (string): Primary-Modell.
- **model** (string, optional): Modell-Override pro Agent.
- **fallbackUrl** (string, optional): Fallback LM-Studio-URL. Leer = kein Fallback.
- **fallbackModel** (string, optional): Fallback-Modellname. Leer = identisch mit defaultModel.
- **probeTimeoutMs** (number): Health-Probe-Timeout vor jedem Heartbeat. Default: \`2000\`.
- **timeoutMs** (number): Voller Call-Timeout. Default: \`120000\`.
- **streamingEnabled** (boolean): Token-Streaming. Default: \`true\`.
- **maxIterations** (number): Max Tool-Iterationen pro Heartbeat. Default: \`25\`.
- **maxRunSeconds** (number): Wallclock-Budget pro Run. Default: \`300\`.
`;
```

- [ ] **Step 3: Build prüfen**

Run: `cd paperclip-adapter-lmstudio && pnpm build`
Expected: Kein TypeScript-Fehler.

- [ ] **Step 4: Commit**

```bash
git add paperclip-adapter-lmstudio/src/index.ts paperclip-adapter-lmstudio/src/server/index.ts
git commit -m "feat(adapter-lmstudio): add fallback config fields (fallbackUrl, fallbackModel, probeTimeoutMs)"
```

---

## Task 2: Typisierte Errors im llm-client

**Files:**
- Modify: `paperclip-adapter-lmstudio/src/server/llm-client.ts`
- Test: `paperclip-adapter-lmstudio/tests/llm-client-errors.test.ts` (neu)

**Context:** Der Fallback-Switch soll gezielt bei Netzwerk-/Modell-/Timeout-Fehlern greifen, nicht bei beliebigen Fehlern. Dafür braucht es typisierte Error-Klassen.

- [ ] **Step 1: Test-Datei anlegen und ersten failing Test schreiben**

Create `paperclip-adapter-lmstudio/tests/llm-client-errors.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { callChatCompletion, LlmClientError } from "../src/server/llm-client.js";

describe("LlmClientError classification", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("classifies connection refused as 'network'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    ));

    await expect(
      callChatCompletion({
        url: "http://localhost:9999",
        model: "m",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("classifies AbortError as 'timeout'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    ));

    await expect(
      callChatCompletion({
        url: "http://localhost:1234",
        model: "m",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("classifies HTTP 404 model-not-found as 'model'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "model 'foo' not found",
    }));

    await expect(
      callChatCompletion({
        url: "http://localhost:1234",
        model: "foo",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "model" });
  });

  it("classifies HTTP 500 as 'unknown'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "oops",
    }));

    await expect(
      callChatCompletion({
        url: "http://localhost:1234",
        model: "foo",
        messages: [],
        tools: [],
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ kind: "unknown" });
  });

  it("exposes LlmClientError with message including reason", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }),
    ));

    const promise = callChatCompletion({
      url: "http://localhost:9999",
      model: "m",
      messages: [],
      tools: [],
      timeoutMs: 1000,
    });

    await expect(promise).rejects.toBeInstanceOf(LlmClientError);
    await expect(promise).rejects.toMatchObject({
      kind: "network",
      message: expect.stringContaining("ECONNREFUSED"),
    });
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd paperclip-adapter-lmstudio && pnpm vitest run tests/llm-client-errors.test.ts`
Expected: FAIL — `LlmClientError` ist nicht exportiert / Errors haben kein `kind`-Feld.

- [ ] **Step 3: LlmClientError-Klasse in llm-client.ts einführen**

In `paperclip-adapter-lmstudio/src/server/llm-client.ts`, **oben** nach den Interfaces hinzufügen:

```typescript
export type LlmErrorKind = "network" | "model" | "timeout" | "unknown";

export class LlmClientError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmClientError";
  }
}

function classifyFetchError(err: unknown): LlmClientError {
  if (err instanceof LlmClientError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) {
      return new LlmClientError("timeout", `LLM call timed out: ${err.message}`, err);
    }
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? "";
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EHOSTUNREACH" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET"
    ) {
      return new LlmClientError("network", `LLM network error: ${code} (${err.message})`, err);
    }
  }
  return new LlmClientError("unknown", `LLM call failed: ${String(err)}`, err);
}

function classifyHttpError(status: number, body: string): LlmClientError {
  if (status === 404 || /model.*not.*found|no.*model.*loaded/i.test(body)) {
    return new LlmClientError(
      "model",
      `LM Studio model error ${status}: ${body || "model not found"}`,
    );
  }
  return new LlmClientError("unknown", `LM Studio API error ${status}: ${body}`);
}
```

- [ ] **Step 4: callChatCompletion auf typisierte Errors umstellen**

In derselben Datei die `callChatCompletion`-Funktion ersetzen:

```typescript
export async function callChatCompletion(req: CompletionRequest): Promise<CompletionResponse> {
  let response: Response;
  try {
    response = await fetch(`${req.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        tools: req.tools,
        tool_choice: "auto",
        stream: false,
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    throw classifyFetchError(err);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw classifyHttpError(response.status, text);
  }

  const data = await response.json() as {
    choices: Array<{ message: AssistantMessage }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const message = data.choices[0]?.message;
  if (!message) throw new LlmClientError("unknown", "No message in response");

  return {
    message,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}
```

- [ ] **Step 5: streamChatCompletion ebenso anpassen**

Ersetze die `streamChatCompletion`-Funktion — der Kopf (fetch/error-Teil) bekommt dieselbe Behandlung:

```typescript
export async function streamChatCompletion(req: StreamRequest): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${req.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
      }),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    throw classifyFetchError(err);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw classifyHttpError(response.status, text);
  }

  const body = response.body;
  if (!body) throw new LlmClientError("unknown", "No response body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            fullText += token;
            await req.onToken(token);
          }
        } catch {
          // Skip malformed SSE
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}
```

- [ ] **Step 6: Tests laufen lassen — müssen grün sein**

Run: `cd paperclip-adapter-lmstudio && pnpm vitest run tests/llm-client-errors.test.ts`
Expected: PASS (5 Tests).

- [ ] **Step 7: Gesamte Test-Suite prüfen (Regressions-Check)**

Run: `cd paperclip-adapter-lmstudio && pnpm test`
Expected: Alle bestehenden Tests weiterhin grün. Die alten Tests erwarten `Error`-Messages — `LlmClientError` erbt von `Error`, also kompatibel.

- [ ] **Step 8: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/llm-client.ts paperclip-adapter-lmstudio/tests/llm-client-errors.test.ts
git commit -m "feat(adapter-lmstudio): typed LlmClientError (network/model/timeout/unknown)"
```

---

## Task 3: probeEndpoint-Funktion

**Files:**
- Modify: `paperclip-adapter-lmstudio/src/server/llm-client.ts`
- Test: `paperclip-adapter-lmstudio/tests/probe.test.ts` (neu)

**Context:** Leichtgewichtiger Health-Check (`GET /v1/models` mit kurzem Timeout) vor jedem Heartbeat. Gibt nur `{ ok: true }` oder `{ ok: false, reason }` zurück — wirft keine Errors.

- [ ] **Step 1: Test-Datei anlegen**

Create `paperclip-adapter-lmstudio/tests/probe.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { probeEndpoint } from "../src/server/llm-client.js";

describe("probeEndpoint", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns ok:true when server responds 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "m" }] }),
    }));

    const result = await probeEndpoint("http://localhost:1234", 500);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with reason when connection refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }),
    ));

    const result = await probeEndpoint("http://localhost:9999", 500);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  it("returns ok:false with reason on timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ));

    const result = await probeEndpoint("http://slow-host:1234", 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/timeout|abort/i);
    }
  });

  it("returns ok:false with reason on HTTP 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }));

    const result = await probeEndpoint("http://localhost:1234", 500);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("500");
    }
  });

  it("never throws — always returns a ProbeResult", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => { throw new Error("boom"); }));
    await expect(probeEndpoint("http://x", 100)).resolves.toHaveProperty("ok", false);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd paperclip-adapter-lmstudio && pnpm vitest run tests/probe.test.ts`
Expected: FAIL — `probeEndpoint` nicht exportiert.

- [ ] **Step 3: probeEndpoint implementieren**

In `paperclip-adapter-lmstudio/src/server/llm-client.ts` am Ende der Datei anfügen:

```typescript
export type ProbeResult = { ok: true } | { ok: false; reason: string };

export async function probeEndpoint(url: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    const response = await fetch(`${url}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText}`.trim() };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === "AbortError" || /aborted|timeout/i.test(err.message)) {
        return { ok: false, reason: `timeout after ${timeoutMs}ms` };
      }
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code) {
        return { ok: false, reason: `${code} (${err.message})` };
      }
      return { ok: false, reason: err.message };
    }
    return { ok: false, reason: String(err) };
  }
}
```

- [ ] **Step 4: Tests laufen lassen — müssen grün sein**

Run: `cd paperclip-adapter-lmstudio && pnpm vitest run tests/probe.test.ts`
Expected: PASS (5 Tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/llm-client.ts paperclip-adapter-lmstudio/tests/probe.test.ts
git commit -m "feat(adapter-lmstudio): add probeEndpoint() for fallback health checks"
```

---

## Task 4: Endpoint-Resolver (Primary + Fallback Entscheidung)

**Files:**
- Create: `paperclip-adapter-lmstudio/src/server/endpoint-resolver.ts`
- Test: `paperclip-adapter-lmstudio/tests/endpoint-resolver.test.ts` (neu)

**Context:** Reines Logik-Modul, das anhand der Config und Probe-Ergebnisse entscheidet, welcher Endpoint für den Heartbeat aktiv ist. Keine Side-Effects außer dem Probe-Call selbst. Macht es trivial testbar.

- [ ] **Step 1: Test-Datei anlegen**

Create `paperclip-adapter-lmstudio/tests/endpoint-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolvePrimaryOrFallback } from "../src/server/endpoint-resolver.js";
import * as llmClient from "../src/server/llm-client.js";

describe("resolvePrimaryOrFallback", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("uses primary when primary probe ok", async () => {
    vi.spyOn(llmClient, "probeEndpoint").mockResolvedValueOnce({ ok: true });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint).toEqual({ url: "http://primary:1234", model: "big" });
      expect(result.usingFallback).toBe(false);
    }
  });

  it("falls back when primary probe fails and fallback probe ok", async () => {
    vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: false, reason: "ECONNREFUSED" })
      .mockResolvedValueOnce({ ok: true });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint).toEqual({ url: "http://fallback:1234", model: "small" });
      expect(result.usingFallback).toBe(true);
      expect(result.primaryFailureReason).toContain("ECONNREFUSED");
    }
  });

  it("uses primary model name as fallback model when fallbackModel is empty", async () => {
    vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: false, reason: "timeout" })
      .mockResolvedValueOnce({ ok: true });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.endpoint).toEqual({ url: "http://fallback:1234", model: "big" });
    }
  });

  it("returns error when no fallback configured and primary fails", async () => {
    vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: false, reason: "ECONNREFUSED" });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "",
      fallbackModel: "",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain("primary");
      expect(result.errorMessage).toContain("ECONNREFUSED");
    }
  });

  it("returns error when both primary and fallback fail", async () => {
    vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: false, reason: "ECONNREFUSED" })
      .mockResolvedValueOnce({ ok: false, reason: "timeout after 500ms" });

    const result = await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 500,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain("primary");
      expect(result.errorMessage).toContain("ECONNREFUSED");
      expect(result.errorMessage).toContain("fallback");
      expect(result.errorMessage).toContain("timeout");
    }
  });

  it("skips primary probe only once — does not re-probe", async () => {
    const probeSpy = vi.spyOn(llmClient, "probeEndpoint")
      .mockResolvedValueOnce({ ok: true });

    await resolvePrimaryOrFallback({
      primaryUrl: "http://primary:1234",
      primaryModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 500,
    });

    expect(probeSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd paperclip-adapter-lmstudio && pnpm vitest run tests/endpoint-resolver.test.ts`
Expected: FAIL — `endpoint-resolver.ts` existiert nicht.

- [ ] **Step 3: endpoint-resolver.ts implementieren**

Create `paperclip-adapter-lmstudio/src/server/endpoint-resolver.ts`:

```typescript
import { probeEndpoint } from "./llm-client.js";

export interface Endpoint {
  url: string;
  model: string;
}

export interface ResolveParams {
  primaryUrl: string;
  primaryModel: string;
  fallbackUrl: string;
  fallbackModel: string;
  probeTimeoutMs: number;
}

export type ResolveResult =
  | {
      ok: true;
      endpoint: Endpoint;
      usingFallback: boolean;
      primaryFailureReason?: string;
    }
  | {
      ok: false;
      errorMessage: string;
    };

export async function resolvePrimaryOrFallback(p: ResolveParams): Promise<ResolveResult> {
  const primaryProbe = await probeEndpoint(p.primaryUrl, p.probeTimeoutMs);
  if (primaryProbe.ok) {
    return {
      ok: true,
      endpoint: { url: p.primaryUrl, model: p.primaryModel },
      usingFallback: false,
    };
  }

  if (!p.fallbackUrl) {
    return {
      ok: false,
      errorMessage: `LM Studio primary nicht erreichbar: ${p.primaryUrl} (${primaryProbe.reason}). Kein Fallback konfiguriert.`,
    };
  }

  const fallbackProbe = await probeEndpoint(p.fallbackUrl, p.probeTimeoutMs);
  if (!fallbackProbe.ok) {
    return {
      ok: false,
      errorMessage:
        `LM Studio nicht erreichbar:\n` +
        `  primary = ${p.primaryUrl} (${primaryProbe.reason})\n` +
        `  fallback = ${p.fallbackUrl} (${fallbackProbe.reason})`,
    };
  }

  return {
    ok: true,
    endpoint: {
      url: p.fallbackUrl,
      model: p.fallbackModel || p.primaryModel,
    },
    usingFallback: true,
    primaryFailureReason: primaryProbe.reason,
  };
}
```

- [ ] **Step 4: Tests laufen lassen — müssen grün sein**

Run: `cd paperclip-adapter-lmstudio && pnpm vitest run tests/endpoint-resolver.test.ts`
Expected: PASS (6 Tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/endpoint-resolver.ts paperclip-adapter-lmstudio/tests/endpoint-resolver.test.ts
git commit -m "feat(adapter-lmstudio): endpoint-resolver decides primary vs fallback"
```

---

## Task 5: Fallback in execute.ts integrieren

**Files:**
- Modify: `paperclip-adapter-lmstudio/src/server/execute.ts`
- Test: `paperclip-adapter-lmstudio/tests/fallback.test.ts` (neu)

**Context:** Hier kommt alles zusammen. Am Heartbeat-Start wird `resolvePrimaryOrFallback` aufgerufen. Der ausgewählte `currentEndpoint` fließt in **alle** LLM-Calls im Heartbeat (inkl. final-streaming). Wenn während eines Calls ein `network`/`model`/`timeout`-Error von `LlmClientError` auftritt UND noch nicht auf dem Fallback → einmaliger Mid-Call-Switch. Meta-Event beim Wechsel.

- [ ] **Step 1: fallback.test.ts anlegen**

Create `paperclip-adapter-lmstudio/tests/fallback.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execute } from "../src/server/execute.js";

function makeCtx(overrides: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  const logs: string[] = [];
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "lmstudio_local",
      adapterConfig: {},
    },
    config: {
      url: "http://primary:1234",
      defaultModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 200,
      timeoutMs: 5000,
      maxIterations: 3,
      ...overrides,
    },
    context: { paperclipApiUrl: "http://localhost:3100", ...context },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
    authToken: "test-auth",
    logs,
  };
}

// Helper: find a logged JSON event by kind + text-substring
function findEvent(logs: string[], kind: string, textSubstr: string): unknown {
  for (const line of logs) {
    try {
      const obj = JSON.parse(line.trim());
      if (obj.kind === kind && typeof obj.text === "string" && obj.text.includes(textSubstr)) {
        return obj;
      }
    } catch { /* not JSON */ }
  }
  return null;
}

const streamBody = () => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n'));
      c.close();
    },
  });
};

const okModelsResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id: "m" }] }),
});

const connRefused = () => Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } });
const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });

describe("execute — fallback behavior", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("uses primary when primary probe ok (no meta event)", async () => {
    const fetchMock = vi.fn()
      // Primary probe (GET /v1/models)
      .mockResolvedValueOnce(okModelsResponse())
      // LLM turn 1: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "All done" } }],
        }),
      })
      // Stream repeat
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(findEvent(ctx.logs, "system", "Fallback aktiv")).toBeNull();
    // All LLM calls went to primary
    const primaryHits = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("http://primary"));
    expect(primaryHits.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back and posts meta event when primary probe fails", async () => {
    const fetchMock = vi.fn()
      // Primary probe fails
      .mockRejectedValueOnce(connRefused())
      // Fallback probe ok
      .mockResolvedValueOnce(okModelsResponse())
      // LLM turn 1 on fallback: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "All done" } }],
        }),
      })
      // Stream repeat on fallback
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(findEvent(ctx.logs, "system", "Fallback aktiv")).not.toBeNull();
    // Final calls went to fallback
    const fallbackHits = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("http://fallback"),
    );
    expect(fallbackHits.length).toBeGreaterThanOrEqual(2);
  });

  it("fails cleanly when primary probe fails and no fallback configured", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(connRefused());
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ fallbackUrl: "" });
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("llm_unreachable");
    expect(result.errorMessage).toContain("primary");
    expect(result.errorMessage).toContain("ECONNREFUSED");
  });

  it("fails cleanly when both primary and fallback probes fail", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(connRefused())
      .mockRejectedValueOnce(abortErr());
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("llm_unreachable");
    expect(result.errorMessage).toContain("primary");
    expect(result.errorMessage).toContain("fallback");
  });

  it("switches to fallback mid-call on network error", async () => {
    const fetchMock = vi.fn()
      // Primary probe ok
      .mockResolvedValueOnce(okModelsResponse())
      // LLM turn 1 on primary: connection drops mid-call
      .mockRejectedValueOnce(connRefused())
      // LLM turn 1 retry on fallback: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Recovered" } }],
        }),
      })
      // Stream repeat on fallback
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(findEvent(ctx.logs, "system", "Fallback aktiv")).not.toBeNull();
  });

  it("sticky: once on fallback, stays on fallback for rest of heartbeat", async () => {
    const fetchMock = vi.fn()
      // Primary probe fails
      .mockRejectedValueOnce(connRefused())
      // Fallback probe ok
      .mockResolvedValueOnce(okModelsResponse())
      // LLM turn 1 on fallback: tool call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "paperclip_get_identity", arguments: "{}" },
              }],
            },
          }],
        }),
      })
      // Tool call to paperclip API (not LM Studio)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "agent-1", name: "CEO" }) })
      // LLM turn 2 on fallback: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Done" } }],
        }),
      })
      // Stream repeat on fallback
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);

    // Count meta events — should be exactly ONE, not per-call
    const metaCount = ctx.logs.filter((l) => {
      try {
        const o = JSON.parse(l.trim());
        return o.kind === "system" && typeof o.text === "string" && o.text.includes("Fallback aktiv");
      } catch { return false; }
    }).length;
    expect(metaCount).toBe(1);

    // Every LM-Studio call (probe of primary failed, everything else) went to fallback
    const lmStudioCalls = fetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes(":1234/"));
    const primaryAfterProbe = lmStudioCalls.slice(1).filter((u) => u.startsWith("http://primary"));
    expect(primaryAfterProbe.length).toBe(0);
  });

  it("uses primaryModel name on fallback when fallbackModel is empty", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(connRefused())
      .mockResolvedValueOnce(okModelsResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Done" } }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ fallbackModel: "" });
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    // The POST body for LLM call on fallback should use primary's model name "big"
    const llmCallWithBody = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes("http://fallback") && init?.method === "POST",
    );
    expect(llmCallWithBody).toBeDefined();
    const body = JSON.parse(llmCallWithBody![1].body);
    expect(body.model).toBe("big");
  });

  it("does not switch to fallback for non-failover errors (e.g. malformed response)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okModelsResponse())
      // LLM returns 500 — this is "unknown" kind, should not trigger fallback
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "server error",
      });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("llm_error");
    // No fallback attempt — no meta event
    expect(findEvent(ctx.logs, "system", "Fallback aktiv")).toBeNull();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd paperclip-adapter-lmstudio && pnpm vitest run tests/fallback.test.ts`
Expected: FAIL — execute.ts hat noch keine Fallback-Logik.

- [ ] **Step 3: execute.ts anpassen — Imports und Config-Lesen**

In `paperclip-adapter-lmstudio/src/server/execute.ts`:

Imports am Anfang erweitern (Zeile 2):

```typescript
import {
  callChatCompletion,
  streamChatCompletion,
  ChatMessage,
  LlmClientError,
  probeEndpoint,
} from "./llm-client.js";
import { resolvePrimaryOrFallback, type Endpoint } from "./endpoint-resolver.js";
```

Innerhalb von `execute()`, **ersetze die Config-Lese-Zeilen** (aktuell 211–213):

```typescript
const primaryUrl = asString(config.url, "http://localhost:1234");
const primaryModel = asString(config.model, "") || asString(config.defaultModel, "");
const fallbackUrl = asString(config.fallbackUrl, "");
const fallbackModel = asString(config.fallbackModel, "");
const probeTimeoutMs = asNumber(config.probeTimeoutMs, 2000);
const timeoutMs = asNumber(config.timeoutMs, 120000);
```

Den `no_model`-Check unverändert lassen, aber auf `primaryModel` umstellen:

```typescript
if (!primaryModel) {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: "No model configured. Set 'defaultModel' in adapter config.",
    errorCode: "no_model",
  };
}
```

- [ ] **Step 4: execute.ts — Probe-Start direkt vor dem Message-Array**

**Füge** den folgenden Block **direkt vor** der bestehenden Zeile `const fileInstructions = await loadInstructionsFromFile(config, ctx.onLog);` (aktuell Zeile 246) ein. Nichts wird ersetzt, nur eingefügt:

```typescript
// Probe + Fallback-Entscheidung für diesen Heartbeat
const resolve = await resolvePrimaryOrFallback({
  primaryUrl,
  primaryModel,
  fallbackUrl,
  fallbackModel,
  probeTimeoutMs,
});

if (!resolve.ok) {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: resolve.errorMessage,
    errorCode: "llm_unreachable",
  };
}

let currentEndpoint: Endpoint = resolve.endpoint;
let onFallback = resolve.usingFallback;

if (onFallback) {
  await logEvent(ctx.onLog, {
    kind: "system",
    text:
      `⚠️ Primary LLM nicht erreichbar (${primaryUrl}).\n` +
      `Fallback aktiv: ${currentEndpoint.url} / ${currentEndpoint.model}\n` +
      `Grund: ${resolve.primaryFailureReason ?? "unbekannt"}`,
  });
}
```

- [ ] **Step 5: execute.ts — Helper für Mid-Call-Switch einfügen**

Innerhalb von `execute()`, **nach** dem Probe-Block und **vor** dem `for (let iteration…)`-Loop, diese Hilfsfunktion deklarieren:

```typescript
// Try a failover on a typed LlmClientError. Returns true if we switched,
// false if no fallback is available or error kind isn't a failover trigger.
async function maybeSwitchToFallback(err: unknown, context: string): Promise<boolean> {
  if (onFallback) return false;
  if (!fallbackUrl) return false;
  if (!(err instanceof LlmClientError)) return false;
  if (err.kind !== "network" && err.kind !== "model" && err.kind !== "timeout") return false;

  // Probe fallback briefly to be sure it's up
  const probe = await probeEndpoint(fallbackUrl, probeTimeoutMs);
  if (!probe.ok) return false;

  currentEndpoint = { url: fallbackUrl, model: fallbackModel || primaryModel };
  onFallback = true;

  await logEvent(ctx.onLog, {
    kind: "system",
    text:
      `⚠️ Primary LLM Fehler während ${context} (${primaryUrl}).\n` +
      `Fallback aktiv: ${currentEndpoint.url} / ${currentEndpoint.model}\n` +
      `Grund: ${err.kind} — ${err.message}`,
  });

  return true;
}
```

- [ ] **Step 6: execute.ts — callChatCompletion mit Fallback-Wrap**

**Ersetze** den bestehenden try/catch um `callChatCompletion` (Zeilen 286–304) durch:

```typescript
let response;
try {
  response = await callChatCompletion({
    url: currentEndpoint.url,
    model: currentEndpoint.model,
    messages,
    tools: PAPERCLIP_TOOLS,
    timeoutMs,
  });
} catch (err) {
  const switched = await maybeSwitchToFallback(err, "chat completion");
  if (switched) {
    try {
      response = await callChatCompletion({
        url: currentEndpoint.url,
        model: currentEndpoint.model,
        messages,
        tools: PAPERCLIP_TOOLS,
        timeoutMs,
      });
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      return {
        exitCode: 1,
        signal: null,
        timedOut: err2 instanceof LlmClientError && err2.kind === "timeout",
        errorMessage: `LLM call failed on fallback: ${msg2}`,
        errorCode: "llm_error",
      };
    }
  } else {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: err instanceof LlmClientError && err.kind === "timeout",
      errorMessage: `LLM call failed: ${msg}`,
      errorCode: "llm_error",
    };
  }
}
```

- [ ] **Step 7: execute.ts — streamChatCompletion auf currentEndpoint umstellen**

Innerhalb des Blocks, der die finale Antwort streamt (aktuell Zeilen 316–335 im Original), **ersetze** den `streamChatCompletion`-Call durch:

```typescript
try {
  finalSummary = await streamChatCompletion({
    url: currentEndpoint.url,
    model: currentEndpoint.model,
    messages: [
      ...messages.slice(0, -1),
      { role: "user", content: "Repeat your previous final answer to me verbatim." },
    ],
    timeoutMs,
    onToken: async (token) => {
      await ctx.onLog("stdout", token);
    },
  });
} catch {
  // Fallback: use the non-streamed content
  finalSummary = msg.content ?? "";
  if (finalSummary) {
    await ctx.onLog("stdout", finalSummary);
  }
}
```

Der umgebende `msg`-Variablenname bleibt gleich (die `msg.content`-Variable ist die Assistant-Message, nicht der LlmClientError).

- [ ] **Step 8: execute.ts — `model` im Return-Objekt aktualisieren**

Am Ende von `execute()` werden mehrere Returns gemacht, die `model` angeben (suchen: `model,\n        provider: "lmstudio"`). Diese Returns erwarten eine `model`-Variable im Scope. Da wir die lokale `model`-Variable gelöscht haben, muss `currentEndpoint.model` verwendet werden. **Finde alle drei Vorkommen** und ersetze `model,` durch `model: currentEndpoint.model,` an diesen Stellen:

1. Im `run_deadline_exceeded`-Return (ca. Zeile 281)
2. Im Success-Return nach Streaming (ca. Zeile 351)
3. Im `max_iterations`-Return am Ende (ca. Zeile 419)

- [ ] **Step 9: Build prüfen**

Run: `cd paperclip-adapter-lmstudio && pnpm build`
Expected: Kein TypeScript-Fehler.

- [ ] **Step 10: Fallback-Tests laufen lassen**

Run: `cd paperclip-adapter-lmstudio && pnpm vitest run tests/fallback.test.ts`
Expected: PASS (8 Tests).

- [ ] **Step 11: Gesamte Test-Suite laufen lassen (Regressions-Check)**

Run: `cd paperclip-adapter-lmstudio && pnpm test`
Expected: Alle Tests grün (execute.test.ts, fallback.test.ts, probe.test.ts, llm-client-errors.test.ts, endpoint-resolver.test.ts, integration.test.ts).

**Wichtig:** In `execute.test.ts` bestehen Tests, die keinen Probe-Mock enthalten. Die bestehenden Mocks werden vom `probeEndpoint`-Call an `/v1/models` konsumiert. Das Ergebnis: Wenn Tests neu fehlschlagen, liegt es wahrscheinlich daran, dass der erste `fetchMock.mockResolvedValueOnce(...)` jetzt vom Probe-Call „verbraucht" wird statt vom ersten LLM-Turn.

- [ ] **Step 12: Wenn execute.test.ts fehlschlägt: Probe-Mocks voranstellen**

Nur ausführen falls Step 11 fehlschlägt. In `paperclip-adapter-lmstudio/tests/execute.test.ts` jedem Test-Setup **an erster Stelle** einen Probe-Mock voranstellen:

```typescript
const fetchMock = vi.fn()
  // Primary probe (GET /v1/models) — added for fallback feature
  .mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "m" }] }),
  })
  // ... bestehende Mocks bleiben wie gehabt danach
```

Das betrifft alle 4 Tests in `describe("execute (agent loop)")` und beide Tests in `describe("execute (post-run guard)")`. Den "no_model"-Test nicht anfassen — der returniert vor dem Probe.

Danach `pnpm test` erneut ausführen. Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/execute.ts paperclip-adapter-lmstudio/tests/fallback.test.ts paperclip-adapter-lmstudio/tests/execute.test.ts
git commit -m "feat(adapter-lmstudio): primary/fallback endpoint with health-probe + sticky switch"
```

---

## Task 6: README-Dokumentation

**Files:**
- Modify: `paperclip-adapter-lmstudio/README.md`

- [ ] **Step 1: Konfigurations-Tabelle erweitern**

In `paperclip-adapter-lmstudio/README.md`, die Tabelle unter „## Konfiguration (pro Agent)" (Zeilen 45–51) ersetzen durch:

```markdown
| Feld | Typ | Default | Beschreibung |
|------|-----|---------|-------------|
| `url` | text | `http://localhost:1234` | Primary LM-Studio-URL |
| `defaultModel` | select | — | Primary-Modell |
| `fallbackUrl` | text | leer | Fallback LM-Studio-URL (z.B. Mac). Leer = kein Fallback |
| `fallbackModel` | text | leer | Fallback-Modellname. Leer = identisch mit `defaultModel` |
| `probeTimeoutMs` | number | `2000` | Timeout für Health-Probe vor jedem Heartbeat |
| `timeoutMs` | number | `120000` | Voller Call-Timeout |
| `streamingEnabled` | boolean | `true` | Token-Streaming |
| `maxIterations` | number | `25` | Max. Tool-Aufrufe pro Heartbeat |
```

- [ ] **Step 2: Neuen Abschnitt „## Fallback-Endpoint" einfügen**

Direkt vor „## Verfügbare Tools" (Zeile 53) einfügen:

```markdown
## Fallback-Endpoint

Wenn ein zweiter LM-Studio-Host verfügbar ist (z.B. Mac als Backup für den Windows-PC), kann er als Fallback konfiguriert werden:

```json
{
  "url": "http://192.168.1.50:1234",
  "defaultModel": "gemma-4-31b-it",
  "fallbackUrl": "http://localhost:1234",
  "fallbackModel": "gemma-4-27b-it"
}
```

Ablauf pro Heartbeat:

1. Adapter ruft `GET {primaryUrl}/v1/models` mit `probeTimeoutMs` auf.
2. Probe OK → Primary wird für den Heartbeat verwendet.
3. Probe fehlt (Verbindung abgelehnt / DNS / Timeout) → Fallback wird geprüft und verwendet. Ein Meta-Event im Run-Transcript markiert den Wechsel.
4. Auch Fallback nicht erreichbar → Run schlägt fehl mit `errorCode: "llm_unreachable"`.

Wechselt der Adapter mitten im Heartbeat (z.B. weil der Primary während eines Calls abstürzt), bleibt er sticky auf dem Fallback bis zum Heartbeat-Ende. Der nächste Heartbeat probiert wieder Primary zuerst.
```

- [ ] **Step 3: Troubleshooting-Eintrag ergänzen**

Am Ende des „## Troubleshooting"-Abschnitts hinzufügen:

```markdown
- **Fallback greift nicht:** `fallbackUrl` und Erreichbarkeit des Fallback-Hosts prüfen. Logs zeigen `llm_unreachable`-Error mit beiden Probe-Reasons.
- **Fallback wird zu langsam erkannt:** `probeTimeoutMs` verringern (z.B. auf 1000ms).
```

- [ ] **Step 4: Commit**

```bash
git add paperclip-adapter-lmstudio/README.md
git commit -m "docs(adapter-lmstudio): document fallback endpoint configuration"
```

---

## Task 7: Manuelle Verifikation

**Ziel:** Mit echtem LM Studio bestätigen, dass der Fallback im Betrieb funktioniert.

**Context:** Kein Test-Code — diese Tasks werden von Walter manuell durchgeführt. Der Agent dokumentiert die Ergebnisse.

- [ ] **Step 1: Build + Install**

Run: `cd paperclip-adapter-lmstudio && pnpm build`
Expected: Kein Fehler.

- [ ] **Step 2: Walter informieren**

Gib Walter diese Check-Liste zur manuellen Verifikation:

1. Einen LM-Studio-Agent in Paperclip-UI konfigurieren mit:
   - `url` = Windows-PC-IP:1234
   - `defaultModel` = großes Modell (z.B. `gemma-4-31b-it`)
   - `fallbackUrl` = `http://localhost:1234` (Mac)
   - `fallbackModel` = kleineres Mac-Modell
2. Windows-PC aus → Trigger-Heartbeat → Run sollte durchlaufen über Mac. Im Transcript sollte ein „⚠️ Primary LLM nicht erreichbar …" Meta-Event erscheinen.
3. Windows-PC wieder an, LM Studio starten → nächster Heartbeat → Run sollte wieder über Windows laufen (kein Meta-Event).
4. Beide Hosts aus → Heartbeat sollte mit klarem Error „llm_unreachable" fehlschlagen und die Error-Message beide Reasons nennen.

- [ ] **Step 3: Nach Walter's Feedback: evtl. Fixes committen**

Falls Walter Bugs meldet: fixen, Tests ergänzen, neuen Commit. Sonst: Plan abgeschlossen.
