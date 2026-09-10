import {
  createPiStdoutParser,
  parsePiStdoutLine,
} from "@paperclipai/adapter-pi-local/ui";
import type { TranscriptEntry } from "../types";

// Shared Pi plan contract (emitter-owned `delivery_update_plan` tool): one
// Pi `tool_execution_end` JSONL event per invocation whose `result.details`
// carries the canonical `paperclip.plan.updated.v1` snapshot. The TaskChat
// transcript merges same-planId `provider_activity` entries, so every new
// revision supersedes the last and the latest checklist renders.
const PLAN_TOOL_NAME = "delivery_update_plan";
const PLAN_SCHEMA = "paperclip.plan.updated.v1";
const PLAN_EVENT_TYPE = "plan.updated";
const PLAN_ID_FALLBACK = "run-plan";

type PlanStepStatus = "pending" | "in_progress" | "completed" | "blocked";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Mirrors planStepStatus in packages/paperclip-runner/src/provider-events.ts.
function planStepStatus(value: unknown): PlanStepStatus {
  const status = (typeof value === "string" ? value : "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replaceAll("-", "_");
  if (status === "in_progress" || status === "completed" || status === "blocked") return status;
  if (status === "failed" || status === "error") return "blocked";
  return "pending";
}

function tryPlanEntry(event: Record<string, unknown> | null, ts: string): TranscriptEntry | null {
  if (!event || event.type !== "tool_execution_end") return null;
  // Exact tool-name match only; every other tool renders normally below.
  if (event.toolName !== PLAN_TOOL_NAME) return null;
  // Errored invocations never surface a plan; the tool_result stays visible.
  if (event.isError === true) return null;
  const details = asRecord(asRecord(event.result)?.details);
  // Exact schema match only. Malformed plan payloads fall through to normal
  // Pi tool rendering so the event stays visible instead of being swallowed.
  if (!details || details.schema !== PLAN_SCHEMA) return null;

  const planId =
    typeof details.planId === "string" && details.planId ? details.planId : PLAN_ID_FALLBACK;
  const revision =
    Number.isSafeInteger(details.revision) && (details.revision as number) > 0
      ? (details.revision as number)
      : 1;
  const explanation =
    typeof details.explanation === "string" ? details.explanation.slice(0, 4000) : "";
  // Mirrors turnPlanPayload in packages/paperclip-runner/src/provider-events.ts:
  // bounded steps, bodies required, statuses normalized.
  const steps = (Array.isArray(details.steps) ? details.steps : []).slice(0, 256).flatMap(
    (entry, index) => {
      const step = asRecord(entry);
      const body = (typeof step?.body === "string" ? step.body : "").trim().slice(0, 4000);
      if (!body) return [];
      const stepId =
        typeof step?.stepId === "string" && step.stepId ? step.stepId : `step-${index + 1}`;
      return [{ stepId, body, status: planStepStatus(step?.status) }];
    },
  );
  const complete = details.complete === true;
  // Mirrors the paperclip-runner plan status mapping: complete drives the
  // terminal state, anything else leaves the checklist open.
  const status = complete ? "completed" : details.complete === false ? "running" : "informational";

  return {
    kind: "provider_activity",
    ts,
    family: "plan",
    eventType: PLAN_EVENT_TYPE,
    status,
    title: "Plan",
    summary: explanation || PLAN_EVENT_TYPE,
    payload: {
      schema: PLAN_SCHEMA,
      planId,
      revision,
      explanation: explanation || null,
      steps,
      complete,
      syncStatus: "not_applicable",
      documentRevision: null,
    },
  };
}

function parseProcessLine(
  line: string,
  ts: string,
  parsePiLine: (line: string, ts: string) => TranscriptEntry[],
): TranscriptEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }
  const planEntry = tryPlanEntry(asRecord(parsed), ts);
  if (planEntry) {
    return [...parsePiLine(line, ts), planEntry];
  }
  if (asRecord(parsed)) {
    // Recognized Pi events render as Pi messages/tools; unknown JSON object
    // events fall back to stdout inside the Pi parser.
    return parsePiLine(line, ts);
  }
  return [{ kind: "stdout", ts, text: line }];
}

export function createProcessStdoutParser() {
  const piParser = createPiStdoutParser();
  return {
    parseLine: (line: string, ts: string) =>
      parseProcessLine(line, ts, piParser.parseLine),
    reset: piParser.reset,
  };
}

export function parseProcessStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseProcessLine(line, ts, parsePiStdoutLine);
}
