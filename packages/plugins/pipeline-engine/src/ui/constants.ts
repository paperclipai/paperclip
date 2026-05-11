export const DATA_KEYS = {
  LIST_PIPELINES: "list-pipelines",
  GET_PIPELINE: "get-pipeline",
  LIST_RUNS: "list-runs",
  GET_RUN: "get-run",
  LIST_AGENTS: "list-agents",
  LIST_SCHEMAS: "list-schemas",
} as const;

export const ACTION_KEYS = {
  SAVE_PIPELINE: "save-pipeline",
  DELETE_PIPELINE: "delete-pipeline",
  TRIGGER_RUN: "trigger-run",
  CANCEL_RUN: "cancel-run",
} as const;

export const STREAM_CHANNELS = {
  RUN_PROGRESS: "run-progress",
} as const;
