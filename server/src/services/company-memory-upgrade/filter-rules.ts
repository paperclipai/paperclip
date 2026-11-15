/**
 * Deterministic prefilter rules for memory upgrade export (TECH-8572).
 *
 * ARCHITECTURAL CONTRACT:
 * - Stage 1 deterministic classification runs without model cost.
 * - Applies ONLY to clearly transient, operational, or zero-substance records.
 * - Must NEVER drop durable preferences, decisions, facts, lessons, or procedures.
 * - Every rule is explicitly named, versioned, commented with an example, and carries a unique ID.
 */

import type { ExportJsonlRecord } from "./export-contract.js";

export interface DeterministicFilterRule {
  readonly id: string;
  readonly description: string;
  readonly example: string;
  match(text: string, record: ExportJsonlRecord): boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_PREFIX_PATTERN =
  /^(?:run(?:[\s_]+id)?|heartbeat(?:[\s_]+run)?|trace(?:[\s_]+id)?|session(?:[\s_]+id)?|execution(?:[\s_]+id)?)[\s:=#]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUN_ID_STATEMENT_PATTERN =
  /^[a-zA-Z0-9_-]+\s+run\s+id\s+is\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.?$/i;

const API_BASE_STATEMENT_PATTERN =
  /^(?:(?:the\s+)?api\s+(?:base\s+)?(?:url\s+)?(?:is|:)|[a-zA-Z0-9_-]+\s+api\s+base\s+is)\s+(https?:\/\/[^\s]+)\.?$/i;

function isLocalOrApiPath(urlString: string): boolean {
  try {
    const cleanUrl = urlString.replace(/\.+$/, "");
    const parsed = new URL(cleanUrl);
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
    const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    const isApi = pathname.endsWith("/api") || pathname.endsWith("/api/v1");
    return isLocal || isApi;
  } catch {
    return false;
  }
}

const WAKE_TRIGGER_PATTERN =
  /^(?:wake\s+(?:reason|trigger)|triggered\s+by|woken\s+by)[\s:=].+$/i;

const WAKE_CRON_PATTERN =
  /^triggered\s+by\s+cron(?:\s+schedule)?\.?$/i;

const STATUS_COMPLETE_PATTERN =
  /^(?:(?:the\s+)?(?:task|issue|run|job|execution|step)\s+(?:is\s+)?(?:marked\s+done|completed?|finished|succeeded)(?:\s+successfully)?|marked\s+done|completed\s+task\s+execution)\.?$/i;

const TICKET_MARKED_DONE_PATTERN =
  /^[A-Z][A-Z0-9]*-\d+\s+is\s+complete\s+and\s+marked\s+done\.?$/;

const NO_ASSIGNED_TASKS_PATTERN =
  /^(?:(?:there\s+are\s+)?no\s+assigned\s+tasks|currently\s+has\s+no\s+assigned\s+tasks|no\s+tasks\s+assigned)(?:\s+at\s+this\s+time|\s+currently)?\.?$/i;

const MADE_NO_CHANGES_PATTERN =
  /^(?:made\s+no\s+changes|no\s+changes(?:\s+were)?\s+made(?:\s+during\s+this\s+run)?|did\s+not\s+make\s+any\s+changes)\.?$/i;

const NO_NEW_MEMORIES_PATTERN =
  /^(?:no\s+new\s+memories(?:\s+were)?\s+saved|zero\s+memories\s+recorded|no\s+memories\s+to\s+save)\.?$/i;

const AGENT_INSTRUCTION_STRINGS = new Set([
  "you are an autonomous ai agent.",
  "you are an autonomous ai agent",
  "follow the instructions in agents.md.",
  "follow the instructions in agents.md",
  "never print dsns or secrets.",
  "never print dsns or secrets",
  "operating instructions for agent.",
  "operating instructions for agent",
]);

export const DETERMINISTIC_FILTER_RULES: readonly DeterministicFilterRule[] = [
  // Rule 1: Run identifier or bare UUID
  // Example: "Run ID: 550e8400-e29b-41d4-a716-446655440000" or "550e8400-e29b-41d4-a716-446655440000"
  {
    id: "rule_run_identifier_or_uuid",
    description: "Record text is solely a bare UUID or run/trace identifier",
    example: "Run ID: 550e8400-e29b-41d4-a716-446655440000",
    match(text: string): boolean {
      const trimmed = text.trim();
      return UUID_PATTERN.test(trimmed) || RUN_PREFIX_PATTERN.test(trimmed);
    },
  },

  // Rule 2: Run ID statement
  // Example: "Talent run ID is 550e8400-e29b-41d4-a716-446655440000."
  {
    id: "rule_run_id_statement",
    description: "Record text states a named agent run ID",
    example: "Talent run ID is 550e8400-e29b-41d4-a716-446655440000.",
    match(text: string): boolean {
      return RUN_ID_STATEMENT_PATTERN.test(text.trim());
    },
  },

  // Rule 3: API base URL statement
  // Example: "Paperclip API base is http://127.0.0.1:3100/api."
  {
    id: "rule_api_base_url",
    description: "Record text is an explicit API base statement whose URL host is local or path ends in /api or /api/v1",
    example: "Paperclip API base is http://127.0.0.1:3100/api.",
    match(text: string): boolean {
      const trimmed = text.trim();
      const match = trimmed.match(API_BASE_STATEMENT_PATTERN);
      if (!match || !match[1]) return false;
      return isLocalOrApiPath(match[1]);
    },
  },

  // Rule 4: Wake/trigger reason
  // Example: "Wake reason: periodic heartbeat" or "Triggered by cron schedule"
  {
    id: "rule_wake_trigger_reason",
    description: "Record text describes an operational wake or trigger reason",
    example: "Wake reason: periodic heartbeat",
    match(text: string): boolean {
      const trimmed = text.trim();
      return WAKE_TRIGGER_PATTERN.test(trimmed) || WAKE_CRON_PATTERN.test(trimmed);
    },
  },

  // Rule 5: Status complete or marked done
  // Example: "Task is complete." or "Issue marked done."
  {
    id: "rule_status_complete_marked_done",
    description: "Record text is an operational completion status or 'marked done' line",
    example: "Task is complete.",
    match(text: string): boolean {
      return STATUS_COMPLETE_PATTERN.test(text.trim());
    },
  },

  // Rule 6: Ticket marked done statement
  // Example: "ENG-123 is complete and marked done."
  {
    id: "rule_ticket_marked_done",
    description: "Record text reports that a ticket is complete and marked done",
    example: "ENG-123 is complete and marked done.",
    match(text: string): boolean {
      return TICKET_MARKED_DONE_PATTERN.test(text.trim());
    },
  },

  // Rule 7: No assigned tasks
  // Example: "No assigned tasks." or "Currently has no assigned tasks."
  {
    id: "rule_no_assigned_tasks",
    description: "Record text reports that the agent has no assigned tasks",
    example: "No assigned tasks.",
    match(text: string): boolean {
      return NO_ASSIGNED_TASKS_PATTERN.test(text.trim());
    },
  },

  // Rule 8: Made no changes
  // Example: "Made no changes." or "No changes were made during this run."
  {
    id: "rule_made_no_changes",
    description: "Record text reports that no changes were made during the run",
    example: "Made no changes.",
    match(text: string): boolean {
      return MADE_NO_CHANGES_PATTERN.test(text.trim());
    },
  },

  // Rule 9: No new memories saved
  // Example: "No new memories saved." or "Zero memories recorded."
  {
    id: "rule_no_new_memories_saved",
    description: "Record text reports that zero memories were saved or recorded",
    example: "No new memories saved.",
    match(text: string): boolean {
      return NO_NEW_MEMORIES_PATTERN.test(text.trim());
    },
  },

  // Rule 10: Agent instruction echo
  // Example: "You are an autonomous AI agent." or "Follow the instructions in AGENTS.md."
  {
    id: "rule_agent_instruction_echo",
    description: "Record text is an exact echo of agent prompt instructions or operational guidance",
    example: "You are an autonomous AI agent.",
    match(text: string): boolean {
      const normalized = text.trim().toLowerCase();
      return AGENT_INSTRUCTION_STRINGS.has(normalized);
    },
  },
] as const;

export function applyDeterministicFilter(
  record: ExportJsonlRecord,
): DeterministicFilterRule | null {
  const text = record.text ?? "";
  for (const rule of DETERMINISTIC_FILTER_RULES) {
    if (rule.match(text, record)) {
      return rule;
    }
  }
  return null;
}
