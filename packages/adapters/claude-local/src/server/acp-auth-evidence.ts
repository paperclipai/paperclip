import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { detectClaudeLoginRequired } from "./parse.js";

const CLAUDE_ACP_AUTH_FAILURE_PATTERNS = [
  /\b(?:http(?:\/\d(?:\.\d)?)?(?:\s+(?:error|status(?:\s+code)?))?|api\s+error|response\s+status(?:\s+code)?|status\s+code)(?:\s*[:=]\s*|\s+)(?:401|403)\b(?![\s:-]*(?:bytes?|retries|attempts?|milliseconds?|ms|characters?)\b)/i,
  /\b(?:unauthorized|not\s+authorized|not\s+authenticated|401\s+unauthorized|403\s+forbidden)\b/i,
  /\b(?:authentication|authorization|auth)[\s_-]*(?:required|failed|failure|error|invalid|expired|revoked|missing|denied|rejected)\b/i,
  /\b(?:failed|unable|could\s+not|cannot)\s+(?:to\s+)?authenticate\b/i,
  /\bcould\s+not\s+resolve\s+authentication\s+method\b/i,
  /\b(?:missing|required|invalid|expired|revoked|rejected)\b[\s\S]{0,40}\b(?:credentials?|(?:api|bearer|oauth|access)\s+token|api[\s_-]?key)\b/i,
  /\b(?:credentials?|(?:api|bearer|oauth|access)\s+token|api[\s_-]?key)\b[\s\S]{0,40}\b(?:missing|required|invalid|expired|revoked|rejected)\b/i,
  /\bentitlements?\b.{0,40}\b(?:denied|missing|required|insufficient)\b/i,
  /\binsufficient\b.{0,40}\bentitlements?\b/i,
  /\bplease\s+(?:log\s+in|login)\b/i,
  /\b(?:log\s+in|login)\b.{0,40}\b(?:required|first|needed|to\s+authenticate)\b/i,
  /\b(?:requires?|needs?|must)\s+(?:you\s+to\s+)?(?:log\s+in|login|authenticate)\b/i,
];

const CLAUDE_ACP_AUTHORIZATION_FAILURE_PATTERNS = [
  /\b(?:api|provider|account)\b.{0,40}\b(?:forbidden|access\s+denied)\b/i,
  /\b(?:api|provider|account)\b.{0,40}\bpermissions?\b.{0,40}\b(?:denied|missing|required|insufficient)\b/i,
  /\binsufficient\b.{0,40}\b(?:api|provider|account)\b.{0,40}\bpermissions?\b/i,
];

const CLAUDE_ACP_LOCAL_PERMISSION_FAILURE_PATTERN =
  /\b(?:EACCES|EPERM|credentials?[\s_-]+(?:cache|file)|file[\s_-]+permissions?|(?:opening|reading|writing|accessing)\s+(?:a\s+|the\s+)?file)\b|\b(?:open(?:ing)?|read(?:ing)?|writ(?:e|ing)|stat|mkdir|chmod|unlink)\s+(?:["']|\/|[a-z]:\\)/i;

export function hasClaudeAcpAuthEvidence(result: AdapterExecutionResult): boolean {
  const terminalFailure = result.resultJson?.terminalSessionFailure;
  const terminalFailureCategory =
    terminalFailure && typeof terminalFailure === "object"
      ? asString((terminalFailure as Record<string, unknown>).category, "")
      : "";
  if (terminalFailureCategory === "access") return true;

  const errorMeta = result.errorMeta ?? {};
  const messages = [
    result.errorMessage ?? "",
    asString(errorMeta.causeMessage, ""),
  ].filter(Boolean);
  const message = messages.join("\n");
  const authName = asString(errorMeta.errorName, "");

  if (CLAUDE_ACP_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return true;
  if (messages.some((surface) =>
    !CLAUDE_ACP_LOCAL_PERMISSION_FAILURE_PATTERN.test(surface) &&
    CLAUDE_ACP_AUTHORIZATION_FAILURE_PATTERNS.some((pattern) => pattern.test(surface)),
  )) return true;
  const normalizedAuthName = authName.replace(/[^a-z]/gi, "").toLowerCase();
  if (/^(?:auth|authentication|authorization|credential|credentials)(?:error|exception)$/.test(normalizedAuthName)) {
    return true;
  }

  return detectClaudeLoginRequired({
    parsed: { is_error: true, result: message },
    stdout: "",
    stderr: "",
  }).requiresLogin;
}

export function acpxNonAuthFailureCode(result: AdapterExecutionResult): string {
  const acpCode = asString(result.errorMeta?.acpCode, "");
  if (acpCode === "ACP_SESSION_INIT_FAILED") return "acpx_session_init_failed";
  if (acpCode === "ACP_TURN_FAILED") return "acpx_turn_failed";
  if (acpCode === "ACP_BACKEND_MISSING") return "acpx_backend_missing";
  if (acpCode === "ACP_BACKEND_UNAVAILABLE") return "acpx_backend_unavailable";
  const phase = asString(result.errorMeta?.phase, "");
  if (phase === "ensure_session") return "acpx_session_init_failed";
  if (phase === "configure_session") return "acpx_session_config_failed";
  if (phase === "turn") return "acpx_turn_failed";
  return acpCode ? "acpx_protocol_error" : "acpx_runtime_error";
}
