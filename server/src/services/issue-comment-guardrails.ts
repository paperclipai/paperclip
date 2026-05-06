import type { IssueCommentPresentation } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";

const ISSUE_COMMENT_REQUIRED_SECTIONS = [
  {
    label: "当前结论",
    regex: /(^|\n)\s*(?:[-*]\s*)?(?:#+\s*)?当前结论\s*[：:]/m,
  },
  {
    label: "当前执行 owner",
    regex: /(^|\n)\s*(?:[-*]\s*)?(?:#+\s*)?当前执行\s+owner\s*[：:]/mi,
  },
  {
    label: "当前 gate",
    regex: /(^|\n)\s*(?:[-*]\s*)?(?:#+\s*)?当前\s+gate\s*[：:]/mi,
  },
  {
    label: "下一步动作",
    regex: /(^|\n)\s*(?:[-*]\s*)?(?:#+\s*)?下一步动作\s*[：:]/m,
  },
  {
    label: "完成后回到",
    regex: /(^|\n)\s*(?:[-*]\s*)?(?:#+\s*)?(?:完成后回到|回到谁)\s*[：:]/m,
  },
] as const;

const BLOCKED_COMMENT_PATTERNS = [
  {
    kind: "tool_bootstrap_banner",
    reason: "包含 tool/bootstrap 启动横幅",
    regex: /🤖\s*AI Agent with Tool Calling/i,
  },
  {
    kind: "api_key_bootstrap_log",
    reason: "包含 API-key 启动日志短语",
    regex: /^\s*Using API key(?:\s+from)?\s+PAPERCLIP_API_KEY\b.*$/im,
  },
  {
    kind: "paperclip_env_dump",
    reason: "包含 PAPERCLIP 环境变量 dump",
    regex: /^\s*PAPERCLIP_[A-Z0-9_]+\s*=.+$/m,
  },
  {
    kind: "run_log_chunk_id",
    reason: "包含原始 run log 元数据",
    regex: /^\s*Chunk ID:\s+/m,
  },
  {
    kind: "run_log_wall_time",
    reason: "包含原始 run log 耗时元数据",
    regex: /^\s*Wall time:\s+/m,
  },
  {
    kind: "run_log_token_count",
    reason: "包含原始 run log token 元数据",
    regex: /^\s*Original token count:\s+/m,
  },
  {
    kind: "run_log_exit_code",
    reason: "包含原始进程退出日志",
    regex: /^\s*Process exited with code\b/m,
  },
  {
    kind: "run_log_session_id",
    reason: "包含原始 session 日志",
    regex: /^\s*Process running with session ID\b/m,
  },
  {
    kind: "tool_call_payload",
    reason: "包含原始 tool call payload",
    regex: /"recipient_name"\s*:\s*"(?:functions|web)\./i,
  },
  {
    kind: "raw_bearer_header",
    reason: "包含原始 Bearer header",
    regex: /\bAuthorization\s*:\s*Bearer\b/i,
  },
] as const;

const TOOL_DUMP_MARKERS = [
  /\bfunctions\.exec_command\b/i,
  /\bfunctions\.write_stdin\b/i,
  /\bfunctions\.(?:apply_patch|spawn_agent|wait_agent|send_input)\b/i,
  /\bweb\.(?:search_query|open|click|find)\b/i,
  /\btool_uses\b/i,
  /\bX-Paperclip-Run-Id\b/i,
  /\bbash -lc\b/i,
  /\bcurl -sS\b/i,
];

const PEM_BLOCK_RE = /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g;
const SECRET_ASSIGNMENT_RE =
  /\b(api[-_ ]?key|access[-_ ]?token|auth(?:[-_ ]?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_ ]?key|cookie|connectionstring)\s*[:=]\s*([^\s,;]+)/gi;
const DSN_RE = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|kafka|nats|mssql):\/\/[^\s<>'")]+/gi;

function resetRegex(pattern: RegExp) {
  pattern.lastIndex = 0;
}

function matchesRegex(pattern: RegExp, input: string) {
  const matched = pattern.test(input);
  resetRegex(pattern);
  return matched;
}

function uniqueList(values: string[]) {
  return Array.from(new Set(values));
}

function collectBlockedReasons(input: string, options: { machineAuthored?: boolean } = {}) {
  const reasons: string[] = [];
  for (const pattern of BLOCKED_COMMENT_PATTERNS) {
    if (matchesRegex(pattern.regex, input)) {
      reasons.push(pattern.reason);
    }
  }
  const toolDumpMarkerHits = TOOL_DUMP_MARKERS.filter((pattern) => matchesRegex(pattern, input)).length;
  if (options.machineAuthored === true && toolDumpMarkerHits >= 2) {
    reasons.push("包含原始 tool/bootstrap dump 片段");
  }
  return uniqueList(reasons);
}

function validateMachineAuthoredCommentStructure(input: string) {
  const missingSections = ISSUE_COMMENT_REQUIRED_SECTIONS
    .filter((section) => !matchesRegex(section.regex, input))
    .map((section) => section.label);
  if (missingSections.length === 0) {
    return;
  }
  throw unprocessable("Machine-authored issue comment must use the structured status format", {
    missingSections,
    requiredSections: ISSUE_COMMENT_REQUIRED_SECTIONS.map((section) => section.label),
  });
}

function requiresStructuredMachineStatusComment(options: {
  machineAuthored?: boolean;
  presentation?: IssueCommentPresentation | null;
}) {
  if (options.machineAuthored !== true) {
    return false;
  }
  if (options.presentation?.kind === "system_notice") {
    return false;
  }
  return true;
}

function sanitizeSecrets(input: string) {
  let sanitized = redactSensitiveText(input);
  sanitized = sanitized.replace(PEM_BLOCK_RE, "[REDACTED_PEM_BLOCK]");
  resetRegex(PEM_BLOCK_RE);
  sanitized = sanitized.replace(SECRET_ASSIGNMENT_RE, (_match, key: string) => `${key}=[REDACTED]`);
  resetRegex(SECRET_ASSIGNMENT_RE);
  sanitized = sanitized.replace(DSN_RE, "[REDACTED_CONNECTION_STRING]");
  resetRegex(DSN_RE);
  return sanitized;
}

export function sanitizeIssueCommentBody(
  input: string,
  options: { machineAuthored?: boolean; presentation?: IssueCommentPresentation | null } = {},
) {
  const trimmed = input.trim();
  const blockedReasons = collectBlockedReasons(trimmed, options);
  if (blockedReasons.length > 0) {
    throw unprocessable("Issue comment blocked by publish guardrail", {
      blockedReasons,
      machineAuthored: options.machineAuthored === true,
    });
  }
  if (requiresStructuredMachineStatusComment(options)) {
    validateMachineAuthoredCommentStructure(trimmed);
  }
  return sanitizeSecrets(trimmed);
}
