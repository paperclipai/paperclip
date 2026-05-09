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
}
