import type { MaCustomToolSpec } from "./client.js";

// Agent-facing Cornerstone tool names. Order matters only for presentation.
// Handler implementation and write/blocked tool policy live in
// server/src/services/cornerstone-tools.ts; this file is the MA wire spec only.
export const CORNERSTONE_TOOL_NAMES = [
  "get_context",
  "search",
  "list_facts",
  "recall",
  "add_fact",
  "save_conversation",
  "steward_inspect",
  "steward_advise",
  "steward_preview",
  "steward_apply",
  "steward_status",
] as const;

export type CornerstoneToolName = (typeof CORNERSTONE_TOOL_NAMES)[number];

export function isCornerstoneToolName(name: string): name is CornerstoneToolName {
  return (CORNERSTONE_TOOL_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Specs.
//
// One MaCustomToolSpec per agent-facing Cornerstone tool. Input schemas mirror
// the handler's input guards in server/src/services/cornerstone-tools.ts so
// the model sees the same required/optional fields the handler enforces.
//
// Read tools (get_context, search, list_facts, recall, steward_inspect,
// steward_advise) accept an optional `namespace` field. When the task's
// targetWorkspace is set, the handler routes to that workspace and ignores
// the agent-supplied namespace; when it isn't set, the agent-supplied
// namespace is honoured (or the AI_OPS_WRITE_WORKSPACE fallback applies).
//
// Write tools (add_fact, save_conversation, steward_preview, steward_apply)
// do NOT accept `namespace` — writes are always routed to the task's
// targetWorkspace (or AI_OPS_WRITE_WORKSPACE fallback). This is a delegation
// safety guarantee: an agent cannot redirect writes via tool input,
// closing a prompt-injection vector for cross-namespace writes.
// ---------------------------------------------------------------------------

const STEWARD_INSPECT_OPERATIONS = [
  "duplicates",
  "contradictions",
  "stale",
  "expired",
  "orphans",
  "key-taxonomy",
  "missing-dates",
  "stale-embeddings",
  "cross-workspace-duplicates",
  "retrieval-interference",
  "composite-health",
  "fact-quality",
] as const;

const STEWARD_ADVISE_OPERATIONS = [
  "merge",
  "consolidate",
  "stale-review",
  "key-taxonomy",
  "contradictions",
] as const;

const STEWARD_PREVIEW_OPERATIONS = [
  "merge-duplicates",
  "merge-notes",
  "archive-stale",
  "delete-by-filter",
  "consolidate-facts",
  "reembed-stale",
  "rename-keys",
] as const;

function getContextSpec(): MaCustomToolSpec {
  return {
    name: "get_context",
    description:
      "Retrieve structured context from Cornerstone memory for a natural-language query. Returns a composed context bundle (facts, notes, summaries). Use this before making architecture or sprint decisions to ground your reasoning in prior work.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language question, e.g. 'recent Paperclip delegation decisions' or 'Donald's audit findings'.",
        },
        namespace: {
          type: "string",
          description:
            "Defaults to your task's target workspace; pass namespace explicitly to override (only honoured when the task has no target workspace pinned).",
        },
        detail_level: {
          type: "string",
          description:
            "How much detail to return. One of: minimal, standard, comprehensive. Default: standard.",
        },
        max_tokens: {
          type: "integer",
          description: "Soft upper bound on returned token count. Default 2000.",
        },
      },
      required: ["query"],
    },
  };
}

function searchSpec(): MaCustomToolSpec {
  return {
    name: "search",
    description:
      "Lighter-weight lookup than get_context — quick existence check or surface-level answer. Returns a shorter bundle. Use when you need to check whether Cornerstone has anything on a topic before committing to deeper retrieval.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query.",
        },
        namespace: {
          type: "string",
          description:
            "Defaults to your task's target workspace; pass namespace explicitly to override (only honoured when the task has no target workspace pinned).",
        },
        detail_level: {
          type: "string",
          description: "minimal | standard | comprehensive. Default: minimal.",
        },
        max_tokens: {
          type: "integer",
          description: "Soft upper bound on returned token count. Default 600.",
        },
      },
      required: ["query"],
    },
  };
}

function listFactsSpec(): MaCustomToolSpec {
  return {
    name: "list_facts",
    description:
      "List facts by key prefix or category. Returns raw fact rows (key, value, confidence, updated_at). Use for audits, duplicate hunts, or inspecting a known key family (e.g. key_prefix='co_paperclip_').",
    input_schema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          description:
            "Defaults to your task's target workspace; pass namespace explicitly to override (only honoured when the task has no target workspace pinned).",
        },
        key_prefix: {
          type: "string",
          description: "Filter facts whose key starts with this prefix.",
        },
        category: {
          type: "string",
          description: "Filter facts by category (e.g. 'architecture', 'sprint', 'config').",
        },
        limit: {
          type: "integer",
          description: "Maximum number of facts to return (1-500, default server-side).",
        },
      },
      required: [],
    },
  };
}

function recallSpec(): MaCustomToolSpec {
  return {
    name: "recall",
    description:
      "Higher-detail recall for a specific query. Same backend as get_context but with detail_level=comprehensive and larger token budget by default. Use when you need the fullest available context on a narrow topic.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query.",
        },
        namespace: {
          type: "string",
          description:
            "Defaults to your task's target workspace; pass namespace explicitly to override (only honoured when the task has no target workspace pinned).",
        },
        detail_level: {
          type: "string",
          description: "minimal | standard | comprehensive. Default: comprehensive.",
        },
        max_tokens: {
          type: "integer",
          description: "Soft upper bound on returned token count. Default 4000.",
        },
      },
      required: ["query"],
    },
  };
}

function addFactSpec(): MaCustomToolSpec {
  return {
    name: "add_fact",
    description:
      "Record a discrete, stable, referenceable fact to Cornerstone. Always written to your task's target workspace (or the AI_OPS_WRITE_WORKSPACE fallback if the task has no target workspace pinned); namespace cannot be overridden via tool input. Facts must be atomic (one topic), objectively true or user-confirmed, and under ~200 tokens. Use descriptive key conventions (e.g. 'co_paperclip_<topic>').",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Specific, searchable key. Avoid vague names like 'update' or 'note'.",
        },
        value: {
          type: "string",
          description: "Fact body. Include dates where possible ('Deployed 2026-04-20').",
        },
        category: {
          type: "string",
          description:
            "Optional category (e.g. 'architecture', 'sprint', 'deployment'). Default: 'general'.",
        },
        confidence: {
          type: "number",
          description: "Confidence 0.0-1.0. Default 0.9.",
        },
      },
      required: ["key", "value"],
    },
  };
}

function saveConversationSpec(): MaCustomToolSpec {
  return {
    name: "save_conversation",
    description:
      "Persist a business-relevant exchange (decision, debugging session, planning) to Cornerstone. Always written to your task's target workspace (or the AI_OPS_WRITE_WORKSPACE fallback if the task has no target workspace pinned); namespace cannot be overridden via tool input. Captures the WHY behind decisions. Do not save personal/off-topic chatter. Pass descriptive `topic`, not 'conversation about stuff'.",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Short descriptive topic for the exchange.",
        },
        messages: {
          type: "array",
          description:
            "Ordered array of message objects with `role` ('user'|'assistant') and `content`.",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
        },
        source: {
          type: "string",
          description: "Optional source tag (e.g. 'paperclip-workforce:ada').",
        },
      },
      required: ["topic", "messages"],
    },
  };
}

function stewardInspectSpec(): MaCustomToolSpec {
  return {
    name: "steward_inspect",
    description:
      "Run a read-only Cornerstone steward inspection. Surfaces memory-health issues (duplicates, contradictions, stale rows, key-taxonomy drift, etc.). Non-destructive — returns a report the agent can cite in its findings.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: `Which inspection to run. One of: ${STEWARD_INSPECT_OPERATIONS.join(", ")}.`,
        },
        namespace: {
          type: "string",
          description:
            "Defaults to your task's target workspace; pass namespace explicitly to override (only honoured when the task has no target workspace pinned).",
        },
      },
      required: ["operation"],
    },
  };
}

function stewardAdviseSpec(): MaCustomToolSpec {
  return {
    name: "steward_advise",
    description:
      "Request a steward recommendation (merge plan, consolidation plan, taxonomy suggestion). Read-only: returns suggestions an operator can review before running a mutating preview/apply. Each operation requires a candidate list — typically gathered from a prior steward_inspect call: pass the inspect rows back in as the operation-specific field.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: `Which advice operation. One of: ${STEWARD_ADVISE_OPERATIONS.join(", ")}.`,
        },
        namespace: {
          type: "string",
          description:
            "Defaults to your task's target workspace; pass namespace explicitly to override (only honoured when the task has no target workspace pinned).",
        },
        items: {
          type: "array",
          items: { type: "object" },
          description:
            "Required for operation=merge and operation=stale-review. Pairs/items from a prior steward_inspect call (e.g. inspect duplicates → advise merge, inspect stale → advise stale-review).",
        },
        item_type: {
          type: "string",
          description:
            "Optional for operation=merge. Either 'fact' (default) or 'note', matching the source_type of the items.",
        },
        facts: {
          type: "array",
          items: { type: "object" },
          description:
            "Required for operation=consolidate. Fact rows (from inspect duplicates or inspect key-taxonomy) to ask the steward to consolidate into one.",
        },
        inconsistencies: {
          type: "array",
          items: { type: "object" },
          description:
            "Required for operation=key-taxonomy. Naming inconsistencies — typically the rows returned by steward_inspect with operation=key-taxonomy.",
        },
        pairs: {
          type: "array",
          items: { type: "object" },
          description:
            "Required for operation=contradictions. Contradicting fact pairs from a prior steward_inspect with operation=contradictions.",
        },
      },
      required: ["operation"],
    },
  };
}

function stewardPreviewSpec(): MaCustomToolSpec {
  return {
    name: "steward_preview",
    description:
      "Dry-run a mutating steward operation. Returns the exact changes that would be applied by steward_apply, without touching memory. Always run against your task's target workspace (or the AI_OPS_WRITE_WORKSPACE fallback if the task has no target workspace pinned); namespace cannot be overridden via tool input. Per-operation required fields are described below — operations like delete-by-filter and rename-keys reject empty bodies (no-op delete = 400).",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: `Which mutation to preview. One of: ${STEWARD_PREVIEW_OPERATIONS.join(", ")}.`,
        },
        similarity_threshold: {
          type: "number",
          description:
            "Optional for merge-duplicates and merge-notes (default 0.85, range 0-1). Lower = more aggressive grouping.",
        },
        limit: {
          type: "integer",
          description:
            "Optional for merge-duplicates, merge-notes, archive-stale (default 500). Caps the number of candidate rows scanned.",
        },
        days_threshold: {
          type: "integer",
          description:
            "Optional for archive-stale (default 90). Rows untouched for N days become candidates.",
        },
        source_type: {
          type: "string",
          description:
            "Optional for delete-by-filter (default 'fact'). Either 'fact' or 'note'.",
        },
        item_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional for delete-by-filter. SM ids to delete. Most callers should use `keys` instead — this is for internal id-based deletes.",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional for delete-by-filter. Fact keys to delete (resolved server-side). Preferred when you know the keys.",
        },
        confidence_below: {
          type: "number",
          description:
            "Optional for delete-by-filter. Delete rows with confidence below this threshold (0-1).",
        },
        created_before: {
          type: "string",
          description:
            "Optional for delete-by-filter. ISO date — delete rows created before this date.",
        },
        content_filter: {
          type: "string",
          description:
            "Optional for delete-by-filter. Substring match on content. delete-by-filter requires AT LEAST ONE of: item_ids, keys, confidence_below, created_before, content_filter, tags.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional for delete-by-filter. Match rows tagged with any of these.",
        },
        fact_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Required for consolidate-facts. Fact ids to merge into a single consolidated fact.",
        },
        mappings: {
          type: "array",
          items: { type: "object" },
          description:
            "Required for rename-keys. List of {from: oldKey, to: newKey} mappings.",
        },
      },
      required: ["operation"],
    },
  };
}

function stewardApplySpec(): MaCustomToolSpec {
  return {
    name: "steward_apply",
    description:
      "Apply a mutating steward operation. Currently BLOCKED pending the approval-queue UI — every call returns pending_approval with errorCode='approval_queue_not_available'. Use steward_preview instead and surface the audit as a recommendation.",
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description:
            "Which mutation to apply. Blocked at the handler level — prefer steward_preview.",
        },
      },
      required: ["operation"],
    },
  };
}

function stewardStatusSpec(): MaCustomToolSpec {
  return {
    name: "steward_status",
    description:
      "Poll the status of a previously-queued steward maintenance job by its job_id. Returns current state (queued/running/done/failed) and any output.",
    input_schema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Maintenance job id returned by a prior steward operation.",
        },
      },
      required: ["job_id"],
    },
  };
}

export function buildCornerstoneToolSpecs(): MaCustomToolSpec[] {
  return [
    getContextSpec(),
    searchSpec(),
    listFactsSpec(),
    recallSpec(),
    addFactSpec(),
    saveConversationSpec(),
    stewardInspectSpec(),
    stewardAdviseSpec(),
    stewardPreviewSpec(),
    stewardApplySpec(),
    stewardStatusSpec(),
  ];
}
