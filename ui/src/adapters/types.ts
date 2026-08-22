import type { ComponentType } from "react";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

// Re-export shared types so local consumers don't need to change imports
export type { TranscriptEntry, StdoutLineParser, CreateConfigValues } from "@paperclipai/adapter-utils";

export interface StatefulStdoutParser {
  parseLine: (line: string, ts: string) => import("@paperclipai/adapter-utils").TranscriptEntry[];
  reset: () => void;
}

export type StdoutParserFactory = () => StatefulStdoutParser;

export interface TranscriptParserSource {
  parseStdoutLine: (line: string, ts: string) => import("@paperclipai/adapter-utils").TranscriptEntry[];
  createStdoutParser?: StdoutParserFactory;
}

export interface AdapterConfigFieldsProps {
  mode: "create" | "edit";
  isCreate: boolean;
  adapterType: string;
  /** Create mode: raw form values */
  values: CreateConfigValues | null;
  /** Create mode: setter for form values */
  set: ((patch: Partial<CreateConfigValues>) => void) | null;
  /** Edit mode: original adapterConfig from agent */
  config: Record<string, unknown>;
  /** Edit mode: read effective value */
  eff: <T>(group: "adapterConfig", field: string, original: T) => T;
  /** Edit mode: mark field dirty */
  mark: (group: "adapterConfig", field: string, value: unknown) => void;
  /** Available models for dropdowns */
  models: { id: string; label: string }[];
  /** When true, hides the instructions file path field (e.g. during import where it's set automatically) */
  hideInstructionsFile?: boolean;
}

export interface UIAdapterModule extends TranscriptParserSource {
  type: string;
  label: string;
  ConfigFields: ComponentType<AdapterConfigFieldsProps>;
  buildAdapterConfig: (values: CreateConfigValues) => Record<string, unknown>;
  /**
   * Optional issue-chat transcript presentation hints. Shared rendering code
   * resolves these through the registry and never branches on adapter
   * identities, so external/plugin adapters can declare them too. Omitted
   * fields fall back to the defaults every adapter has today.
   */
  transcriptPresentation?: {
    /**
     * Renderable transcript entries kept in the issue-chat window (default
     * 30). Verbose streaming backends emit hundreds of entries per heartbeat;
     * trimming those mid-run drops already-rendered content off the front and
     * the index shift can mangle retraction smoothing.
     */
    maxVisibleEntries?: number;
    /**
     * Live-run reasoning rendering (default "ticker", the one-line rolling
     * view). "scrollLog" renders the full reasoning in a scrollable box that
     * auto-follows the newest line — for backends whose delta volume
     * overwhelms the ticker.
     */
    liveReasoningView?: "ticker" | "scrollLog";
  };
}
