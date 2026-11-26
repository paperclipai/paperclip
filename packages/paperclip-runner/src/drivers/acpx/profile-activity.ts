import { antigravityActivityAdapter } from "./antigravity-activity.js";
import { createCopilotToolEvidence } from "./copilot-tool-evidence.js";
import { cursorActivityAdapter } from "./cursor-activity.js";
import type { CanonicalProviderEvent } from "../../provider-events.js";
import type { AcpxExtensionInput } from "./profile-extensions.js";

export interface AcpxToolEvidence {
  tool(event: unknown): void;
  permission(request: unknown, requestId: string, offeredActions: readonly string[]): ((outcome: string) => void) | undefined;
}

export interface AcpxToolEvidenceBinding {
  sessionId: string;
  turnId: string;
  workingDirectory: string;
  active(): boolean;
  emit(event: CanonicalProviderEvent): void;
  unavailable?(): void;
}

/** Provider-owned identity and diagnostic projection; never permission authority. */
export interface AcpxActivityAdapter {
  toolIdentity?(nativeId: string): string;
  /**
   * One turn's display identity for raw ACP tool updates, for a provider that
   * names no tool: each event with `paperclipToolDetail` added, or null when the
   * call is the provider's own bookkeeping and is not shown. Display only.
   */
  createToolEventProjection?(): <T extends { type: string }>(event: T) => T | null;
  toolExecutionId?(nativeId: string): string;
  inputToolIdentity?(input: AcpxExtensionInput): string | undefined;
  createToolEvidence?(binding: AcpxToolEvidenceBinding): AcpxToolEvidence;
  /** A post-turn diagnostic notice read from the provider's status: a usage or settings receipt bound to this request. */
  usageNotice?(before: unknown, after: unknown, requestId: string, turnId: string): CanonicalProviderEvent | null;
}

const adapters: Readonly<Record<string, AcpxActivityAdapter | undefined>> = {
  cursor: cursorActivityAdapter,
  antigravity: antigravityActivityAdapter,
  copilot: Object.freeze({ createToolEvidence: createCopilotToolEvidence }),
};
const noActivity: AcpxActivityAdapter = Object.freeze({});

export function acpxProfileActivity(agent: string | null | undefined): AcpxActivityAdapter {
  return agent && Object.hasOwn(adapters, agent) ? adapters[agent]! : noActivity;
}
