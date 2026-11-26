import type {
  CapabilityChatSessionArtifact,
  CapabilityChatSessionOptions,
  CapabilityScenarioIndexEntry,
} from "@paperclip-runner-local/capability";

import type { CapabilityChatSessionClient } from "./components/chat-surface.js";

type SessionResponse = {
  sessionId: string;
  artifact: CapabilityChatSessionArtifact;
  nextPrompt: string | null;
};

function apiBaseFromDocument(): URL | null {
  const configured = document
    .querySelector<HTMLMetaElement>('meta[name="scenario-chat-api-base"]')
    ?.content.trim();
  if (!configured) return null;
  const url = new URL(configured.replace(/\/*$/, "/"), document.baseURI);
  return url.origin === window.location.origin ? url : null;
}

async function parseResponse(response: Response): Promise<SessionResponse> {
  if (!response.ok) throw new Error(`The Scenario chat demo returned HTTP ${response.status}.`);
  const value: unknown = await response.json();
  if (
    typeof value !== "object" || value === null ||
    typeof (value as { sessionId?: unknown }).sessionId !== "string" ||
    typeof (value as { artifact?: unknown }).artifact !== "object"
  ) {
    throw new Error("The Scenario chat demo returned an invalid session response.");
  }
  return value as SessionResponse;
}

export class CapabilityRemoteChatSession implements CapabilityChatSessionClient {
  private constructor(
    private readonly apiBase: URL,
    private sessionId: string,
    private currentArtifact: CapabilityChatSessionArtifact,
    private suggestedPrompt: string | null,
  ) {}

  static available(): boolean {
    return apiBaseFromDocument() !== null;
  }

  static async open(
    entry: CapabilityScenarioIndexEntry,
    _options: CapabilityChatSessionOptions = {},
  ): Promise<CapabilityRemoteChatSession> {
    const apiBase = apiBaseFromDocument();
    if (!apiBase) throw new Error("The Scenario chat server endpoint is not configured.");
    const response = await fetch(new URL("sessions", apiBase), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenarioId: entry.id }),
    });
    const opened = await parseResponse(response);
    return new CapabilityRemoteChatSession(
      apiBase,
      opened.sessionId,
      opened.artifact,
      opened.nextPrompt,
    );
  }

  artifact(): CapabilityChatSessionArtifact {
    return this.currentArtifact;
  }

  nextPrompt(): string | null {
    return this.suggestedPrompt;
  }

  async send(prompt: string): Promise<CapabilityChatSessionArtifact> {
    return await this.mutate("turn", { prompt });
  }

  async replay(): Promise<CapabilityChatSessionArtifact> {
    return await this.mutate("replay", {});
  }

  async close(): Promise<void> {
    await fetch(new URL(`sessions/${this.sessionId}`, this.apiBase), {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
  }

  private async mutate(action: "turn" | "replay", body: Record<string, unknown>): Promise<CapabilityChatSessionArtifact> {
    const response = await fetch(new URL(`sessions/${this.sessionId}/${action}`, this.apiBase), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const updated = await parseResponse(response);
    this.sessionId = updated.sessionId;
    this.currentArtifact = updated.artifact;
    this.suggestedPrompt = updated.nextPrompt;
    return this.currentArtifact;
  }
}
